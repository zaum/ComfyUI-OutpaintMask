# ComfyUI Outpaint Mask — Changelog

* **Total commits:** 3 (plus one uncommitted working-tree update)
* **Date range:** 2026-09-12 – 2026-09-17
* **Environment / Context:** Local development; v1.15.0 original_mask output pending commit

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🚀 Features · Added original_mask Full-Canvas Output
* Added a new `original_mask` output right after `original_image`: same full-canvas size, 0.0 on the source, 1.0 on the outpaint area.
* Updated the fallback path to return the new 6-output arity.
* Extended the CPU-only geometry tests to cover the new mask.
* Bumped the frontend and package version to 1.15.0.

`Working Tree` · `Uncommitted`

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🐛 Fixes · Aligned Render Tiles to the Flux2 VAE Grid
* Changed outward frame alignment from 8 to 16 pixels in the editor and Python backend, preventing Flux2's center crop from shifting tiles whose dimensions were only divisible by 8.
* Kept cropped images, masks, preview dimensions and merge coordinates on the same frame without resizing or cropping the source image.
* Updated pixel and millimeter dimension steps, geometry limits and aspect-ratio matching to use the shared grid constant.
* Added CPU-only backend geometry tests and JavaScript save/preview regression checks.
* Bumped the frontend and package version to 1.14.8; retained both LiteGraph and Vue integration paths.
* Documented that older frames may expand outward and alignment can slightly exceed the nominal megapixel cap.

`Working Tree` · `Uncommitted`

---

### <sup><sub style="font-size: 0.7em;">2026-09-14</sub></sup> · 🐛 Fixes · Synchronized Frame Geometry and Image Previews
* Aligned frame edges outward to the original 8 pixel grid and synchronized frontend and backend geometry.
* Reset the frame when the source image changed and synchronized serialized widget values.
* Saved full-resolution node previews and refreshed project screenshots and documentation.
* Grouped consecutive editor synchronization commits from September 13–14.

`Direct Commit` · `5d69170`, `381c58a`

---

### <sup><sub style="font-size: 0.7em;">2026-09-12</sub></sup> · 🚀 Features · Introduced the Outpaint Frame Editor
* Added the interactive frame editor with cropped image, mask, full-canvas and crop-coordinate outputs.

`Direct Commit` · `1cb82b3`
