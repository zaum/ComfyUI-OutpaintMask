# ComfyUI Outpaint Mask — Changelog

* **Total commits:** 12
* **Date range:** 2026-09-12 – 2026-11-11
* **Environment / Context:** Published to the Comfy Registry as `comfyui-outpaintmask` 1.15.0; Manager listing PR #3293 still awaiting approval; 1.15.2 is a post-release stability fix; 1.15.4 restores the frontend on ComfyUI 0.45.2 / frontend 1.58.5

---

### <sup><sub style="font-size: 0.7em;">2026-11-11</sub></sup> · 🐛 Fixes · Restored the Frontend on ComfyUI 0.45
* Repaired a mangled frontend module (interleaved function bodies) that stopped the whole extension from loading, so the editor did not open from the preview and the state widget stayed visible.
* Added a full-width Outpaint Editor button below the image preview and kept it below the preview across frontend re-renders.
* Retargeted preview click-to-open at the core main-image panel and grew the node once per preview size so the image and the button stay inside the node.
* Hid the core "Edit or mask image" action on this node and reused the copy button of another extension instead of stacking a duplicate.
* Matched the preview hover buttons to the native theme by cloning the download button, gave the paste action the clipboard-paste icon, and restyled the foreign copy button that rendered grey in the 1.58 theme.
* Removed the visible version text from the editor button (kept in its tooltip).
* Updated the package version to 1.15.4.

`Direct Commit`

---

### <sup><sub style="font-size: 0.7em;">2026-09-24</sub></sup> · 🐛 Fixes · Restored Outpaint Preview Persistence
* Recreated the node preview from the restored `outpaint_state` after workflow or tab loading, preventing the canvas from reverting to the un-outpainted source image.
* Added delayed retry scheduling so both the legacy LiteGraph canvas and the Vue DOM preview can finish rendering before the composite is applied.
* Preserved the restored mask state while allowing genuine image changes to continue resetting the frame as intended.
* Updated the package version to 1.15.2.

`Direct Commit` · `7a5417d`

---


### <sup><sub style="font-size: 0.7em;">2026-09-24</sub></sup> · 🐛 Fixes · Mask Frame Survives Workflow Tab Switches
* Fixed the mask frame resetting on every workflow tab switch: tab switches recreate the node and apply saved widget values only after creation, so the image-change watcher compared the restored image against the dropdown default and mistook the restore for a user image swap.
* Wrapped `onConfigure` to re-sync the tracked image and state from the restored widgets without resetting, and added an `_opm_restoring` guard across all three reset paths (editor open, widget callback, self-heal tick).
* Genuine image swaps (dropdown, upload, clipboard paste) still reset the frame as before; the fix also covers workflow load and node clone/duplicate.
* Updated the package version to 1.15.1.

`Direct Commit` · `239e59d`

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
