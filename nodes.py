import hashlib
import io
import json
import os
import threading
import time
import traceback

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageOps

import folder_paths

# Canvas dimensions are snapped up to this multiple so the padded image stays
# friendly to latent-space (VAE) based outpainting workflows.
SIZE_SNAP = 8
PREVIEW_DIR_NAME = "outpaint_mask"
PREVIEW_KEEP = 50
MAX_PREVIEW_SIDE = 1024
MAX_PAD = 16384               # absolute clamp for frame pads (negative pad = crop)


def _ceil_snap(v):
    """Round up to a multiple of SIZE_SNAP."""
    return int(((int(v) + SIZE_SNAP - 1) // SIZE_SNAP) * SIZE_SNAP)


def _floor_snap(v):
    """Round down to a multiple of SIZE_SNAP, minimum SIZE_SNAP."""
    return max(SIZE_SNAP, int(int(v) // SIZE_SNAP) * SIZE_SNAP)


def _parse_state(raw):
    """Parse/normalize the editor state JSON produced by the frontend.

    Pads (l/t/r/b) may be negative: a negative pad means the frame cuts
    inside the image on that side, i.e. the node output is CROPPED there.
    """
    st = {"l": 0, "t": 0, "r": 0, "b": 0, "mp_on": True, "mp": 2.0}
    try:
        data = json.loads(raw) if raw else {}
        if isinstance(data, dict):
            for k in ("l", "t", "r", "b"):
                try:
                    st[k] = int(np.clip(int(round(float(data.get(k, 0)))), -MAX_PAD, MAX_PAD))
                except Exception:
                    pass
            st["mp_on"] = bool(data.get("mp_on", True))
            try:
                st["mp"] = float(np.clip(float(data.get("mp", 2.0)), 0.05, 8.0))
            except Exception:
                pass
    except Exception:
        pass
    return st


def _tensor_to_pil(image_opt):
    """Normalize any IMAGE tensor to an HWC uint8 PIL image, or None."""
    try:
        t = image_opt
        if isinstance(t, torch.Tensor):
            t = t.detach()
            if t.ndim == 4:
                if t.shape[0] < 1:
                    return None
                t = t[0]
            elif t.ndim == 2:
                t = t.unsqueeze(-1)
            t = t.clamp(0, 1).cpu().numpy()
        t = np.asarray(t)
        if t.ndim == 4:
            if t.shape[0] < 1:
                return None
            t = t[0]
        if t.ndim == 2:
            t = np.stack([t] * 3, axis=-1)
        if t.shape[2] == 1:
            t = np.repeat(t, 3, axis=2)
        if t.shape[2] == 4:
            t = t[:, :, :3]
        return Image.fromarray((np.clip(t, 0.0, 1.0) * 255.0).astype(np.uint8), "RGB")
    except Exception:
        traceback.print_exc()
        return None


def _prune_dir(d, prefixes, keep=PREVIEW_KEEP):
    """Keep the preview/error cache bounded; best-effort only."""
    try:
        files = [
            os.path.join(d, f)
            for f in os.listdir(d)
            if f.startswith(tuple(prefixes))
        ]
        if len(files) <= keep:
            return
        files.sort(key=lambda p: os.path.getmtime(p))
        for p in files[: len(files) - keep]:
            try:
                os.remove(p)
            except Exception:
                pass
    except Exception:
        pass


def _atomic_write_png(dest, data):
    """Write PNG bytes atomically so concurrent runs never read a partial file."""
    tmp = dest + f".tmp{os.getpid()}_{threading.get_ident()}_{time.time_ns()}"
    with open(tmp, "wb") as f:
        f.write(data)
    try:
        os.replace(tmp, dest)
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass

class OutpaintMaskEditor:
    """Builds an outpaint canvas + mask from a saved frame state.

    Inputs: an image (dropdown/upload like LoadImage) OR a connected IMAGE
    tensor. The frame state (paddings, MP cap) is stored in the
    `outpaint_state` widget by the fullscreen editor. Outputs the padded
    IMAGE (original placed on the canvas, empty areas mid-gray) and a MASK
    (1.0 = area to generate). The node preview shows the image on a neutral
    checkerboard canvas (outpaint area) with a thin frame border.
    """

    @classmethod
    def INPUT_TYPES(s):
        try:
            input_dir = folder_paths.get_input_directory()
            files = [
                f
                for f in os.listdir(input_dir)
                if os.path.isfile(os.path.join(input_dir, f))
            ]
        except Exception as e:
            print(f"[OutpaintMask] could not list input directory: {e}")
            files = []
        return {
            "required": {
                # image_upload: True -> the built-in frontend extension adds
                # the upload/refresh buttons and the preview to the node
                # (same mechanism as LoadImage)
                "image": (sorted(files), {"image_upload": True}),
                "outpaint_state": ("STRING", {"default": "{}"}),
            },
            # optional IMAGE input: when another node's output is connected
            # here, it overrides the dropdown-selected image
            "optional": {
                "image_opt": ("IMAGE",),
            },
        }

    # The frame drawn in the editor IS the render tile (size + context are
    # set by hand, it may cut into the source with negative pads).
    # cropped_image/cropped_mask go to the sampler. original_image is the
    # FULL canvas (whole source + positive outpaint expansion, nothing
    # cropped away) with the source on mid-gray. crop_x/crop_y is the tile
    # top-left on the full canvas; merge with the tile mask, e.g. via the
    # core Image Composite Masked node:
    # composite(original_image, rendered, crop_x, crop_y, cropped_mask).
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "INT", "INT")
    RETURN_NAMES = (
        "cropped_image",
        "cropped_mask",
        "original_image",
        "crop_x",
        "crop_y",
    )
    OUTPUT_NODE = True
    FUNCTION = "load"
    CATEGORY = "image/inpaint"
    DESCRIPTION = (
        "Outpaint mask editor. Select/upload an image, open the editor "
        "(button or right-click menu), drag the frame around the image to "
        "define the outpaint area. The frame is the render tile (you set its "
        "size and context by hand, it may cut into the source). Outputs "
        "CROPPED_IMAGE + CROPPED_MASK for the sampler, ORIGINAL_IMAGE (full "
        "canvas: whole source + outpaint, nothing cropped away), "
        "CROP_X/CROP_Y (tile position). Merge e.g. with the core Image "
        "Composite Masked node: destination=original_image, source=rendered "
        "tile, x=crop_x, y=crop_y, mask=cropped_mask."
    )

    @classmethod
    def VALIDATE_INPUTS(s, image, outpaint_state="{}", **kwargs):
        # The image combo list is computed at node-definition time, but new
        # files can appear later (paste, upload). Validate by file existence
        # instead - same as LoadImage. When image_opt is connected the
        # dropdown value may be stale, so do not reject the node.
        if kwargs.get("image_opt") is not None:
            return True
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True

    # ------------------------------------------------------------------ main

    def load(self, image, outpaint_state="{}", image_opt=None):
        try:
            state = _parse_state(outpaint_state)
            if image_opt is not None:
                src = _tensor_to_pil(image_opt)
                if src is None:
                    raise ValueError("invalid input image tensor")
                src_ref = self._save_source(src)
            else:
                img_path = folder_paths.get_annotated_filepath(image)
                with Image.open(img_path) as im:
                    tmp = ImageOps.exif_transpose(im)
                    if tmp.mode in ("I", "I;16", "I;16B", "I;16L"):
                        tmp = tmp.point(lambda i: i * (1 / 255)).convert("L")
                    src = tmp.convert("RGB")
                parts = str(image).split("/")
                src_ref = {
                    "filename": parts[-1],
                    "subfolder": "/".join(parts[:-1]),
                    "type": "input",
                }

            w, h = src.size
            l, t, r, b = state["l"], state["t"], state["r"], state["b"]
            # Canvas size == frame selection size. When pads are negative the
            # frame cuts INSIDE the image and the node output is cropped there;
            # the canvas can then be smaller than the source image.
            raw_cw = max(SIZE_SNAP, w + l + r)
            raw_ch = max(SIZE_SNAP, h + t + b)
            cw = _ceil_snap(raw_cw)
            ch = _ceil_snap(raw_ch)

            arr = np.asarray(src, dtype=np.float32) / 255.0
            # Background of the outpaint area: mid-gray (128), not black.
            out_image = np.full((ch, cw, 3), 0.5, dtype=np.float32)
            out_mask = np.ones((ch, cw), dtype=np.float32)
            # Visible part of the source = intersection of the source rect
            # (top-left at (l, t)) with the canvas rect. Everything outside is
            # cropped (negative pads) or becomes outpaint area (positive).
            ix0, iy0 = max(l, 0), max(t, 0)
            ix1, iy1 = min(l + w, cw), min(t + h, ch)
            if ix1 > ix0 and iy1 > iy0:
                sub_l = ix0 - l
                sub_t = iy0 - t
                out_image[iy0:iy1, ix0:ix1, :] = arr[
                    sub_t : sub_t + (iy1 - iy0), sub_l : sub_l + (ix1 - ix0), :
                ]
                out_mask[iy0:iy1, ix0:ix1] = 0.0

            prev_ref = self._save_preview(src, cw, ch, l, t, w, h)
            ui = {
                "images": [prev_ref] if prev_ref else [],
                "source": [src_ref],
                "state": json.dumps(state),
            }
            pct = float((out_mask > 0.5).mean()) * 100.0
            # Full merge canvas: the WHOLE source plus the positive outpaint
            # expansion (negative pads never shrink it). The tile sits on it
            # at (tx, ty); the mask is white outside the source rect.
            lp, tp, rp, bp = max(l, 0), max(t, 0), max(r, 0), max(b, 0)
            tx, ty = lp - l, tp - t
            fw = _ceil_snap(max(SIZE_SNAP, w + lp + rp, tx + cw))
            fh = _ceil_snap(max(SIZE_SNAP, h + tp + bp, ty + ch))
            original_np = np.full((fh, fw, 3), 0.5, dtype=np.float32)
            original_np[tp : tp + h, lp : lp + w, :] = arr
            print(
                f"[OutpaintMask] canvas {cw}x{ch} image {w}x{h} "
                f"pads l={l} t={t} r={r} b={b} mask={pct:.1f}% "
                f"full {fw}x{fh} tile+{tx}+{ty}"
            )
            return {
                "ui": ui,
                "result": (
                    torch.from_numpy(out_image)[None,],
                    torch.from_numpy(out_mask)[None,],
                    torch.from_numpy(original_np)[None,],
                    tx,
                    ty,
                ),
            }
        except Exception as e:
            print(f"[OutpaintMask] load() failed: {e}")
            traceback.print_exc()
            return self._error_fallback(image_opt)


    # ------------------------------------------------------------ helpers

    def _preview_dir(self):
        d = os.path.join(folder_paths.get_input_directory(), PREVIEW_DIR_NAME)
        os.makedirs(d, exist_ok=True)
        return d

    def _save_source(self, src):
        """Save a tensor-sourced image to the input dir so the editor can
        load it later via /view (tensor inputs have no source file)."""
        save_name = None
        try:
            buf = io.BytesIO()
            src.save(buf, format="PNG", compress_level=1)
            data = buf.getvalue()
            m = hashlib.sha256(data)
            save_name = f"outpaint_src_{m.hexdigest()[:16]}.png"
            dest = os.path.join(self._preview_dir(), save_name)
            if not os.path.isfile(dest):
                _atomic_write_png(dest, data)
            _prune_dir(self._preview_dir(), ("outpaint_src_", "outpaint_preview_", "outpaint_error_"))
        except Exception as e:
            print(f"[OutpaintMask] source save failed: {e}")
            return None
        return {"filename": save_name, "subfolder": PREVIEW_DIR_NAME, "type": "input"}

    def _gap_tile(self, size=16):
        """Neutral checkerboard tile for the outpaint area (no color tint)."""
        tile = Image.new("RGB", (size, size), (51, 51, 51))
        d = ImageDraw.Draw(tile)
        h = size // 2
        d.rectangle([0, 0, h - 1, h - 1], fill=(62, 62, 62))
        d.rectangle([h, h, size - 1, size - 1], fill=(62, 62, 62))
        return tile

    def _save_preview(self, src, cw, ch, l, t, w, h):
        """Compose the node preview: original image on a checkerboard canvas
        (outpaint area), thin frame border, no burned-in labels."""
        save_name = None
        try:
            ts = 16
            tile = self._gap_tile(ts)
            base = Image.new("RGB", (cw, ch), (51, 51, 51))
            for y in range(0, ch, ts):
                for x in range(0, cw, ts):
                    base.paste(tile, (x, y))
            base.paste(src.convert("RGB"), (l, t))

            if max(cw, ch) > MAX_PREVIEW_SIDE:
                sc = MAX_PREVIEW_SIDE / float(max(cw, ch))
                base = base.resize(
                    (max(8, int(cw * sc)), max(8, int(ch * sc))), Image.BILINEAR
                )
            buf = io.BytesIO()
            base.save(buf, format="PNG", compress_level=1)
            data = buf.getvalue()
            m = hashlib.sha256(data)
            save_name = f"outpaint_preview_{m.hexdigest()[:16]}.png"
            dest = os.path.join(self._preview_dir(), save_name)
            if not os.path.isfile(dest):
                _atomic_write_png(dest, data)
            _prune_dir(self._preview_dir(), ("outpaint_src_", "outpaint_preview_", "outpaint_error_"))
        except Exception as e:
            print(f"[OutpaintMask] preview save failed: {e}")
            save_name = None
        if not save_name:
            return None
        return {"filename": save_name, "subfolder": PREVIEW_DIR_NAME, "type": "input"}

    def _error_fallback(self, image_opt):
        """Bulletproof fallback: never raises, always returns valid tensors."""
        w, h = 256, 256
        out_image = None
        try:
            if image_opt is not None:
                t = _tensor_to_pil(image_opt)
                if t is not None:
                    w, h = t.size
                    out_image = torch.from_numpy(
                        np.asarray(t, dtype=np.float32) / 255.0
                    )[None,]
        except Exception:
            out_image = None
        ui_images = []
        try:
            err_img = Image.new("RGB", (w, h), (64, 0, 0))
            buf = io.BytesIO()
            err_img.save(buf, format="PNG", compress_level=1)
            save_name = f"outpaint_error_{int(time.time() * 1000)}.png"
            _atomic_write_png(os.path.join(self._preview_dir(), save_name), buf.getvalue())
            ui_images = [
                {"filename": save_name, "subfolder": PREVIEW_DIR_NAME, "type": "input"}
            ]
        except Exception:
            pass
        if out_image is None:
            out_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
        out_mask = torch.zeros((1, h, w), dtype=torch.float32)
        # Result arity must always match RETURN_TYPES.
        return {
            "ui": {"images": ui_images},
            "result": (out_image, out_mask, out_image, 0, 0),
        }

    @classmethod
    def IS_CHANGED(s, image, outpaint_state="{}", image_opt=None, **kwargs):
        # Fast, crash-proof change detection: mtime + size of the source file
        # plus a hash of the frame state, so editing the frame in the UI also
        # re-runs the node. When an IMAGE tensor is connected upstream, its
        # content is fingerprinted too - otherwise swapping the upstream image
        # would go unnoticed and the node would stale-cache.
        state_hash = hashlib.sha256(str(outpaint_state).encode("utf-8")).hexdigest()[:16]
        try:
            if image_opt is not None:
                try:
                    t = image_opt.detach() if isinstance(image_opt, torch.Tensor) else None
                    if t is not None:
                        if t.ndim == 4:
                            if t.shape[0] < 1:
                                return str(time.time_ns())
                            t = t[0]
                        fp = f"{tuple(t.shape)}:{t.dtype}"
                        flat = t.contiguous().view(-1) if t.is_contiguous() else t.reshape(-1)
                        n = flat.numel()
                        if n > 0:
                            step = max(1, n // 4096)
                            sample = flat[::step][:4096]
                            try:
                                b = sample.to("cpu").contiguous().numpy().tobytes()
                            except Exception:
                                b = str(sample.to("cpu").tolist()[:256]).encode("utf-8")
                            fp += ":" + hashlib.sha256(b).hexdigest()[:16]
                        return fp + ":" + state_hash
                except Exception:
                    pass
                # Fingerprint failed: always re-run rather than risk a stale cache.
                return float("nan")
            img_path = folder_paths.get_annotated_filepath(image)
            try:
                stt = os.stat(img_path)
                h = f"{stt.st_mtime_ns}:{stt.st_size}"
            except Exception:
                h = str(image)
            return h + ":" + state_hash
        except Exception:
            return str(time.time_ns())


NODE_CLASS_MAPPINGS = {
    "OutpaintMaskEditor": OutpaintMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OutpaintMaskEditor": "Outpaint Mask Editor",
}
