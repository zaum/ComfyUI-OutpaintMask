"""CPU-only geometry regressions; run with python -m unittest discover -s tests."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import torch

ROOT = Path(__file__).resolve().parents[1]


def load_backend():
    spec = importlib.util.spec_from_file_location("outpaint_geometry", ROOT / "nodes.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"folder_paths": types.ModuleType("folder_paths")}):
        spec.loader.exec_module(module)
    return module


class FrameAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = load_backend()

    def render(self, w, h, pads):
        editor = self.backend.OutpaintMaskEditor()
        editor._save_source = lambda *args: None
        editor._save_preview = lambda *args: None
        # Integer-valued colors survive the node's uint8 image conversion.
        source = (torch.arange(h * w * 3).reshape(1, h, w, 3) % 256).float() / 255
        with contextlib.redirect_stdout(io.StringIO()):
            result = editor.load("", json.dumps(dict(zip("ltrb", pads))), source)["result"]
        tile, mask, full, x, y = result
        th, tw = tile.shape[1:3]
        self.assertEqual(tw % 16, 0)
        self.assertEqual(th % 16, 0)
        self.assertEqual(tuple(mask.shape), (1, th, tw))
        self.assertTrue(torch.equal(tile, full[:, y:y + th, x:x + tw]))
        l, t, r, b = pads
        fx = (-l // 16) * 16
        fy = (-t // 16) * 16
        right = ((w + r + 15) // 16) * 16
        bottom = ((h + b + 15) // 16) * 16
        self.assertEqual((tw, th), (right - fx, bottom - fy))
        self.assertEqual((x, y), (max(fx, 0), max(fy, 0)))
        lp, tp = max(-fx, 0), max(-fy, 0)
        self.assertTrue(torch.equal(full[:, tp:tp + h, lp:lp + w], source))
        xs = torch.arange(tw) + fx
        ys = torch.arange(th) + fy
        expected_mask = ~((ys[:, None] >= 0) & (ys[:, None] < h)
                          & (xs[None, :] >= 0) & (xs[None, :] < w))
        self.assertTrue(torch.equal(mask[0], expected_mask.float()))
        # Model the VAE's center-crop size calculation: neither axis may move.
        self.assertEqual(((tw % 16) // 2, (th % 16) // 2), (0, 0))
        return tile

    def test_1032_expands_to_1040(self):
        self.assertEqual(self.render(1032, 576, (0, 0, 0, 0)).shape[2], 1040)

    def test_crop_outpaint_and_odd_source_sizes(self):
        cases = [
            (64, 64, (-16, 0, 8, 0)),
            (257, 129, (-24, -8, 32, 16)),
            (257, 129, (8, 24, -16, -32)),
            (1031, 575, (0, 0, 0, 0)),
            (256, 128, (16, 16, 16, 16)),
            (256, 128, (-32, -16, -16, -32)),
        ]
        for w, h, pads in cases:
            with self.subTest(size=(w, h), pads=pads):
                self.render(w, h, pads)


if __name__ == "__main__":
    unittest.main()
