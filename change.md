# ComfyUI Outpaint Mask — Changelog

* **Total commits:** 9
* **Date range:** 2026-09-12 – 2026-09-17
* **Environment / Context:** Published to the Comfy Registry as `comfyui-outpaintmask` 1.15.0; Manager listing PR #3293 still awaiting approval

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🚀 Features · Published to the Comfy Registry
* Published version 1.15.0 to the Comfy Registry under publisher `zaum`; the node became active with the screenshot-derived icon and banner.
* Set the registry `PublisherId` in package metadata and committed it.
* The Manager listing request remains pending as a parallel, legacy-channel registration.

`Direct Commit` · `a8c3eed`

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🎨 UI/UX · Prepared Screenshot-Based Registry Artwork
* Created a 400 × 400 icon and a 1260 × 540 banner from the existing screenshot, preserving its aspect ratio and content.
* Replaced the emoji icon with public-repository image URLs in the Icon and Banner package metadata.
* Documented that Manager listing approval has no guaranteed timeline and Registry artwork requires separate publication.

`Direct Commit` · `dd30b78`


---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🛠️ Maintenance · Updated Presentation and Compositing Documentation
* Updated repository presentation, screenshots and example workflow assets.
* Clarified the README compositing instructions.
* Grouped consecutive presentation and documentation updates.

`Direct Commit` · `7653efc`, `486c514`

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🚀 Features · Added Full-Canvas Mask Output
* Added original_mask alongside the full-canvas image and updated the output arity.
* Updated the package version to 1.15.0.

`Direct Commit` · `b8f913d`

---

### <sup><sub style="font-size: 0.7em;">2026-09-17</sub></sup> · 🐛 Fixes · Aligned Frames to the Flux2 VAE Grid
* Aligned frame snapping to a 16-pixel grid for Flux2 VAE compatibility.

`Direct Commit` · `377b9cd`

---

### <sup><sub style="font-size: 0.7em;">2026-09-14</sub></sup> · 🐛 Fixes · Synchronized Editor Geometry and Previews
* Aligned frame geometry and synchronized saved widget values.
* Reset the frame on image changes and saved full-resolution previews.
* Grouped consecutive synchronization updates from September 13–14.

`Direct Commit` · `5d69170`, `381c58a`

---

### <sup><sub style="font-size: 0.7em;">2026-09-12</sub></sup> · 🚀 Features · Introduced the Outpaint Frame Editor
* Added the interactive frame editor with cropped and full-canvas outputs.

`Direct Commit` · `1cb82b3`
