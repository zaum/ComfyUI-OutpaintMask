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
RENDER_KEEP_N = 8            # max render variants kept for the editor gallery
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
    render_pick/render_drop select the accepted render variant (see the
    editor gallery): pick is an index into the batch minus dropped items.
    """
    st = {
        "l": 0, "t": 0, "r": 0, "b": 0, "mp_on": True, "mp": 2.0,
        "render_pick": 0, "render_drop": [],
    }
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
            try:
                st["render_pick"] = max(0, int(data.get("render_pick", 0)))
            except Exception:
                pass
            try:
                drop = data.get("render_drop", [])
                if isinstance(drop, (list, tuple)):
                    st["render_drop"] = sorted({max(0, int(v)) for v in drop})
            except Exception:
                pass
    except Exception:
        pass
    return st


def _pick_batch_index(n, state):
    """Accepted render variant: state pick into the batch minus drops."""
    try:
        drop = set(state.get("render_drop", []) or [])
    except Exception:
        drop = set()
    avail = [i for i in range(max(0, int(n))) if i not in drop] or [0]
    try:
        pick = int(state.get("render_pick", 0) or 0)
    except Exception:
        pick = 0
    return avail[max(0, min(pick, len(avail) - 1))]


def _tensor_fp(t):
    """Sampled content fingerprint for an IMAGE tensor (or None).

    Same sampled-hash scheme the node uses for change detection: shape +
    dtype + a strided content sample, so a new render always re-runs the
    merge instead of serving a stale cache.
    """
    try:
        if not isinstance(t, torch.Tensor):
            return None
        t = t.detach()
        if t.ndim == 4:
            if t.shape[0] < 1:
                return None
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
        return fp
    except Exception:
        return None


def _tensor_to_pil(image_opt, index=0):
    """Normalize any IMAGE tensor to an HWC uint8 PIL image, or None.

    index selects the batch item (clamped); the gallery accept flow picks
    the render variant this way.
    """
    try:
        t = image_opt
        if isinstance(t, torch.Tensor):
            t = t.detach()
            if t.ndim == 4:
                if t.shape[0] < 1:
                    return None
                t = t[max(0, min(int(index), t.shape[0] - 1))]
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
            # here, it overrides the dropdown-selected image.
            # rendered is LAZY: the sampler output may be wired back into
            # the same node without a circular-connection error (same
            # pattern as InpaintCanvas result/result_local). The node first
            # runs without it (crops + gallery refs), then re-runs merged
            # once the sampler output resolves.
            "optional": {
                "image_opt": ("IMAGE",),
                "rendered": ("IMAGE", {"lazy": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    # The frame drawn in the editor IS the render tile (size + context are
    # set by hand, it may cut into the source with negative pads).
    # cropped_image/cropped_mask go to the sampler. original_image is the
    # FULL canvas (whole source + positive outpaint expansion, nothing
    # cropped away) with the source on mid-gray. crop_x/crop_y is the tile
    # top-left on the full canvas; merged is the accepted render variant
    # pasted back (same-node feedback only - for a real workflow feed the
    # crop outputs through a sampler into a separate OutpaintMerge node,
    # otherwise the graph is circular). job carries the normalized state
    # (pads, pick/drop) for the merge node.
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "INT", "INT", "IMAGE", "STRING")
    RETURN_NAMES = (
        "cropped_image",
        "cropped_mask",
        "original_image",
        "crop_x",
        "crop_y",
        "merged",
        "job",
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
        "CROP_X/CROP_Y (tile position). Feed the sampler output back into "
        "the RENDERED input and MERGED returns it pasted onto the full "
        "canvas (accepted gallery variant, originals bit-identical). The "
        "RENDERED input is lazy, so it may be wired back into the same "
        "node without a circular-connection error. The Render button "
        "queues the workflow; the editor gallery lists the render variants "
        "for preview (click), accept (green check) and delete (red X)."
    )

    @classmethod
    def check_lazy_status(cls, prompt=None, unique_id=None, **kwargs):
        # Request the lazy sampler output only when it is actually wired:
        # the prompt then holds [node_id, slot] for it. Unwired -> run
        # immediately with rendered=None. (The core filters out already
        # resolved inputs itself, so this is also safe on re-execution.)
        try:
            node = (prompt or {}).get(str(unique_id), {})
            inputs = node.get("inputs", {})
            if isinstance(inputs.get("rendered"), list):
                return ["rendered"]
        except Exception:
            pass
        return []

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

    def load(self, image, outpaint_state="{}", image_opt=None, rendered=None,
             prompt=None, unique_id=None):
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
            render_refs = self._save_renders(rendered, cw, ch)
            try:
                if isinstance(rendered, torch.Tensor) and rendered.ndim == 4:
                    render_n = int(rendered.shape[0])
                elif rendered is not None:
                    render_n = 1
                else:
                    render_n = 0
            except Exception:
                render_n = 0
            # NOTE: every ui value MUST be a list: the core merges ui dicts
            # with {k: [y for x in uis for y in x[k]]}, so a bare int
            # crashes ("'int' object is not iterable") and a bare string is
            # split into characters (the frontend joins it back).
            ui = {
                "images": [prev_ref] if prev_ref else [],
                "source": [src_ref],
                "state": [json.dumps(state)],
                "renders": render_refs,
                "render_n": [render_n],
            }
            pct = float((out_mask > 0.5).mean()) * 100.0
            # Full merge canvas: the WHOLE source plus the positive outpaint
            # expansion (negative pads never shrink it). The tile sits on it
            # at (tx, ty); the merge mask is white outside the source rect.
            lp, tp, rp, bp = max(l, 0), max(t, 0), max(r, 0), max(b, 0)
            tx, ty = lp - l, tp - t
            fw = _ceil_snap(max(SIZE_SNAP, w + lp + rp, tx + cw))
            fh = _ceil_snap(max(SIZE_SNAP, h + tp + bp, ty + ch))
            original_np = np.full((fh, fw, 3), 0.5, dtype=np.float32)
            original_np[tp : tp + h, lp : lp + w, :] = arr
            full_mask_np = np.ones((fh, fw), dtype=np.float32)
            full_mask_np[tp : tp + h, lp : lp + w] = 0.0
            merged_np = self._merge_rendered(
                rendered, state, original_np, full_mask_np, tx, ty, cw, ch
            )
            # Publish the final composite for the editor gallery (only when
            # a render was actually merged - otherwise it would duplicate
            # the full canvas).
            merged_ref = None
            if merged_np is not original_np:
                try:
                    buf = io.BytesIO()
                    Image.fromarray(
                        (np.clip(merged_np, 0.0, 1.0) * 255.0).astype(np.uint8), "RGB"
                    ).save(buf, format="PNG", compress_level=1)
                    data = buf.getvalue()
                    m = hashlib.sha256(data)
                    save_name = f"outpaint_merged_{m.hexdigest()[:16]}.png"
                    dest = os.path.join(self._preview_dir(), save_name)
                    if not os.path.isfile(dest):
                        _atomic_write_png(dest, data)
                    merged_ref = {
                        "filename": save_name,
                        "subfolder": PREVIEW_DIR_NAME,
                        "type": "input",
                    }
                    _prune_dir(self._preview_dir(), ("outpaint_merged_",))
                except Exception as e:
                    print(f"[OutpaintMask] merged save failed: {e}")
                    merged_ref = None
            ui["merged_ref"] = [merged_ref] if merged_ref else []
            print(
                f"[OutpaintMask] canvas {cw}x{ch} image {w}x{h} "
                f"pads l={l} t={t} r={r} b={b} mask={pct:.1f}% "
                f"full {fw}x{fh} tile+{tx}+{ty} "
                f"renders={len(render_refs)} merged={'yes' if merged_np is not original_np else 'no'}"
            )
            return {
                "ui": ui,
                "result": (
                    torch.from_numpy(out_image)[None,],
                    torch.from_numpy(out_mask)[None,],
                    torch.from_numpy(original_np)[None,],
                    tx,
                    ty,
                    torch.from_numpy(merged_np)[None,],
                    json.dumps(state),
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

    def _save_renders(self, rendered, cw, ch):
        """Persist the sampler output batch for the editor gallery.

        Each variant is stored at tile size (paste-ready) and returned as a
        /view ref. Capped so a big batch cannot flood the input dir.
        """
        refs = []
        try:
            if not isinstance(rendered, torch.Tensor):
                return refs
            n = int(rendered.shape[0]) if rendered.ndim == 4 else 1
            for i in range(min(n, RENDER_KEEP_N)):
                try:
                    pim = _tensor_to_pil(rendered, index=i)
                    if pim is None:
                        continue
                    if pim.size != (cw, ch):
                        pim = pim.resize((cw, ch), Image.BILINEAR)
                    buf = io.BytesIO()
                    pim.save(buf, format="PNG", compress_level=1)
                    data = buf.getvalue()
                    m = hashlib.sha256(data)
                    save_name = f"outpaint_render_{m.hexdigest()[:16]}.png"
                    dest = os.path.join(self._preview_dir(), save_name)
                    if not os.path.isfile(dest):
                        _atomic_write_png(dest, data)
                    refs.append(
                        {"filename": save_name, "subfolder": PREVIEW_DIR_NAME, "type": "input"}
                    )
                except Exception as e:
                    print(f"[OutpaintMask] render save failed (item {i}): {e}")
            _prune_dir(self._preview_dir(), ("outpaint_render_",))
            if n > RENDER_KEEP_N:
                print(f"[OutpaintMask] batch has {n} renders, gallery keeps {RENDER_KEEP_N}")
        except Exception as e:
            print(f"[OutpaintMask] render save failed: {e}")
        return refs

    def _merge_rendered(self, rendered, state, full_np, full_mask_np, tx, ty, cw, ch):
        """Paste the accepted render variant onto the full canvas.

        Selection = state render_pick / render_drop (editor gallery): pick is
        an index into the batch minus dropped items. The variant is resized
        to tile size when the sampler worked at another resolution, and only
        the outpaint part lands (mask blend) so originals stay bit-identical.
        No usable render: returns the full canvas itself (pass-through).
        """
        try:
            if not isinstance(rendered, torch.Tensor):
                return full_np
            n = int(rendered.shape[0]) if rendered.ndim == 4 else 1
            if n < 1:
                return full_np
            choice = _pick_batch_index(n, state)
            pim = _tensor_to_pil(rendered, index=choice)
            if pim is None:
                return full_np
            if pim.size != (cw, ch):
                print(
                    f"[OutpaintMask] render {pim.size} != tile {(cw, ch)}, resizing"
                )
                pim = pim.resize((cw, ch), Image.BILINEAR)
            gen = np.asarray(pim, dtype=np.float32) / 255.0
            placed = full_np.copy()
            placed[ty : ty + ch, tx : tx + cw, :] = gen
            m = full_mask_np[..., None]
            return (m * placed + (1.0 - m) * full_np).astype(np.float32)
        except Exception as e:
            print(f"[OutpaintMask] merge failed: {e}")
            return full_np

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
            "result": (out_image, out_mask, out_image, 0, 0, out_image, "{}"),
        }

    @classmethod
    def IS_CHANGED(s, image, outpaint_state="{}", image_opt=None, rendered=None, **kwargs):
        # Fast, crash-proof change detection: mtime + size of the source file
        # plus a hash of the frame state, so editing the frame in the UI also
        # re-runs the node. Connected IMAGE tensors (upstream image, sampler
        # output) are fingerprinted too - otherwise swapping them would go
        # unnoticed and the node would stale-cache (a new render must always
        # re-run the merge).
        state_hash = hashlib.sha256(str(outpaint_state).encode("utf-8")).hexdigest()[:16]
        try:
            render_fp = "render:none"
            if rendered is not None:
                render_fp = _tensor_fp(rendered)
                if render_fp is None:
                    # Fingerprint failed: always re-run rather than risk a
                    # stale merge.
                    return float("nan")
                render_fp = "render:" + render_fp
            if image_opt is not None:
                fp = _tensor_fp(image_opt)
                if fp is None:
                    return float("nan")
                return fp + ":" + state_hash + ":" + render_fp
            img_path = folder_paths.get_annotated_filepath(image)
            try:
                stt = os.stat(img_path)
                h = f"{stt.st_mtime_ns}:{stt.st_size}"
            except Exception:
                h = str(image)
            return h + ":" + state_hash + ":" + render_fp
        except Exception:
            return str(time.time_ns())


class OutpaintMerge:
    """Paste a rendered tile back onto the full canvas (linear flow).

    The editor node cannot feed its own outputs back into its own inputs
    (that is a circular connection, rejected by ComfyUI), so the merge lives
    here: base canvas + rendered tile batch + tile mask + tile position +
    job state -> merged full canvas. Original pixels stay bit-identical.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "base_image": ("IMAGE",),
                "rendered": ("IMAGE",),
                "tile_mask": ("MASK",),
                "tile_x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "tile_y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "job": ("STRING", {"default": "{}"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("merged",)
    FUNCTION = "merge"
    CATEGORY = "image/inpaint"
    DESCRIPTION = (
        "Outpaint merge. Pastes the accepted sampler tile back onto the "
        "full canvas at (tile_x, tile_y), blended with tile_mask. Wire: "
        "base_image=original_image, rendered=sampler output, "
        "tile_mask=cropped_mask, tile_x=crop_x, tile_y=crop_y, "
        "job=editor job output (carries the gallery pick)."
    )

    def merge(self, base_image, rendered, tile_mask, tile_x, tile_y, job="{}"):
        try:
            state = _parse_state(job)
            base = _tensor_to_pil(base_image)
            if base is None:
                raise ValueError("invalid base_image tensor")
            barr = np.asarray(base, dtype=np.float32) / 255.0
            bh, bw = barr.shape[0], barr.shape[1]
            m0 = None
            try:
                mt = tile_mask.detach() if isinstance(tile_mask, torch.Tensor) else None
                if mt is not None:
                    if mt.ndim == 3:
                        mt = mt[0] if mt.shape[0] > 0 else None
                    if mt is not None:
                        m0 = np.asarray(mt.clamp(0, 1).cpu().numpy(), dtype=np.float32)
            except Exception:
                m0 = None
            if m0 is None or m0.ndim != 2:
                raise ValueError("invalid tile_mask tensor")
            mh, mw = m0.shape[0], m0.shape[1]
            n = 0
            try:
                if isinstance(rendered, torch.Tensor):
                    n = int(rendered.shape[0]) if rendered.ndim == 4 else 1
            except Exception:
                n = 0
            if n < 1:
                raise ValueError("empty rendered batch")
            choice = _pick_batch_index(n, state)
            rpim = _tensor_to_pil(rendered, index=choice)
            if rpim is None:
                raise ValueError("invalid rendered tensor")
            if rpim.size != (mw, mh):
                print(
                    f"[OutpaintMask] merge render {rpim.size} != tile {(mw, mh)}, resizing"
                )
                rpim = rpim.resize((mw, mh), Image.BILINEAR)
            gen = np.asarray(rpim, dtype=np.float32) / 255.0
            out = barr.copy()
            x, y = int(tile_x), int(tile_y)
            dx0, dy0 = max(0, x), max(0, y)
            dx1, dy1 = min(bw, x + mw), min(bh, y + mh)
            if dx1 > dx0 and dy1 > dy0:
                sx0, sy0 = dx0 - x, dy0 - y
                w_, h_ = dx1 - dx0, dy1 - dy0
                m = m0[sy0 : sy0 + h_, sx0 : sx0 + w_][..., None]
                t = gen[sy0 : sy0 + h_, sx0 : sx0 + w_, :]
                reg = out[dy0:dy1, dx0:dx1, :]
                out[dy0:dy1, dx0:dx1, :] = m * t + (1.0 - m) * reg
            print(
                f"[OutpaintMask] merged variant {choice} at+{x}+{y} "
                f"tile {mw}x{mh} base {bw}x{bh}"
            )
            return (torch.from_numpy(out.astype(np.float32))[None,],)
        except Exception as e:
            print(f"[OutpaintMask] merge() failed: {e}")
            traceback.print_exc()
            try:
                if isinstance(base_image, torch.Tensor) and base_image.ndim == 4:
                    return (base_image[0:1].detach().cpu().float(),)
            except Exception:
                pass
            return (torch.zeros((1, 64, 64, 3), dtype=torch.float32),)

    @classmethod
    def IS_CHANGED(s, base_image, rendered, tile_mask, tile_x, tile_y, job="{}"):
        # Every tensor input is fingerprinted: a new render must always
        # re-run the merge instead of serving a stale cache.
        try:
            parts = [f"{tile_x}x{tile_y}"]
            parts.append(hashlib.sha256(str(job).encode("utf-8")).hexdigest()[:16])
            for t in (base_image, rendered, tile_mask):
                fp = _tensor_fp(t)
                if fp is None:
                    return float("nan")
                parts.append(fp)
            return ":".join(parts)
        except Exception:
            return str(time.time_ns())


NODE_CLASS_MAPPINGS = {
    "OutpaintMaskEditor": OutpaintMaskEditor,
    "OutpaintMerge": OutpaintMerge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OutpaintMaskEditor": "Outpaint Mask Editor",
    "OutpaintMerge": "Outpaint Merge",
}
