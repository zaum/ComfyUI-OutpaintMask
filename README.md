# ComfyUI Outpaint Mask

Custom ComfyUI node for creating **outpaint masks** interactively.

Select or upload an image on the node (or hover the preview and use the
clipboard-paste icon, like on the FastMask node), then open the
**fullscreen editor** (button below the node preview, preview click, or
right-click menu). Drag the frame around the image to define the
outpaint area:

- 8 draggable handles: corners resize proportionally by default (hold
  Shift for free resize), edges resize in one direction, dragging the
  middle moves the whole frame. Cropping into the image is allowed, but
  the frame and the image must always touch or overlap: the frame can
  never leave the picture fully. Frame sides snap exactly to the image
  edges and center lines at any zoom (the snap decision uses the raw
  pointer, never the 8 px grid), even for non-8-divisible image sizes; a snapped
  side glows blue while held, and a dashed guide spans the image while
  snapped to a center line. The aspect-ratio preset buttons are
  ONE-SHOT size setters: they set the frame once and nothing keeps the
  ratio afterwards.
- Snapping to the original image edges and to 8 px multiples.
- Aspect-ratio preset buttons (1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16,
  21:9, 9:21) shown as one segmented control. Each preset creates the
  SMALLEST frame with that ratio that still contains the image: one side
  of the frame equals the image's width or height. Presets resize around
  the current mask center. The matching preset highlights automatically,
  even when the frame was resized by dragging the handles.
- Pixel/millimeter readout switch (px | mm) with a DPI field (default 300,
  enabled in mm mode). In mm mode every size on screen (W/H inputs, gap
  labels, frame chip, status bar) is shown in millimeters; the internal
  model stays in pixels.
- Adjustable megapixel cap ("Limit megapixel" toggle + slider with
  typical values + narrow manual input) that the frame area cannot exceed.
  Slider stops track native model sizes (0.26 = SD1.5 512^2, 0.59 = SD2.x
  768^2, 1.05 = SDXL/SD3 1024^2) plus larger working sizes up to 8 MP.
  While dragging (or hovering) the slider, a bubble shows the cap MP and
  the live frame pixel size.
  Cap changes shrink the frame around its center (position stays put).
  Corner drags may overshoot the cap while held (no hard wall) and spring
  back on release. Growing into the cap by hand fires one short amber
  frame flash (never blinks continuously). Snapped frame sides glow blue
  while the mouse button is held.
- Editable frame W/H inputs: typing a size keeps the frame position
  and only changes the size (snapped to 8 px); the spinner steps by 8 px
  (or its mm equivalent). Live gap labels on every side and the frame
  size chip next to the frame show only while the cursor is inside the
  frame; the bottom info bar shows Image size → Output (canvas) size.
- The view always fits the whole frame after a frame change, so the full
  mask stays visible. Wheel: zoom (kept until the next frame change).
  Middle-mouse drag or empty click: pan (panning never triggers the
  auto-fit).
- Cancel / OK in the top-right corner; Reset restores the image-size
  frame (clamped to the megapixel cap when the limit is on).

The node outputs:

- `cropped_image` — the frame canvas = your render tile (size and context
  drawn by hand, it may cut into the source), empty outpaint areas are
  mid-gray (128).
- `cropped_mask` — `1.0` where the image must be generated (outside the
  original, inside the frame), `0.0` over the original image.
- `original_image` — FULL canvas (whole source + outpaint expansion,
  nothing cropped away): the source on mid-gray.
- `crop_x` / `crop_y` — top-left position of the tile on the full canvas.

Merge with the core Image Composite Masked node: destination=
`original_image`, source=rendered tile (upscale to tile size first if the
sampler worked at a different resolution), x=`crop_x`, y=`crop_y`,
mask=`cropped_mask`, resize_source off. Original pixels stay bit-identical.

## Render variants gallery

Connect the sampler output to the `rendered` input and add a `merged`
output downstream: `merged` is the accepted variant pasted onto the full
canvas (or the full canvas itself while `rendered` is unconnected). The
**Render** button in the editor topbar queues the current workflow;
the editor's right-side strip lists every render variant as a thumbnail:

- click a thumbnail (or Enter) to preview it on the workspace — only the
  outpaint part shows, originals stay intact; double-click accepts it,
- hover a thumbnail for **✓** (green check: keep only this one and use
  it) and **✕** (red X: delete just this one),
- OK writes the selection into the workflow (`render_pick` /
  `render_drop`); the backend merges that variant on the next run.

The node preview shows the original image on a neutral checkerboard
canvas (outpaint area) with a thin frame border and no burned-in labels.
On OK the preview is instantly replaced (aspect-correct) with the new
canvas size; the next queue swaps in the backend-rendered image. The
fixed-height editor button sits below the preview; the frame-state field
is hidden (it still travels to the backend with the prompt).

Compatible with both frontend generations (Nodes 1 / LiteGraph canvas and
Nodes 2 / Vue).

## Install

Copy (or symlink) this folder into `ComfyUI/custom_nodes/ComfyUI-OutpaintMask`
and restart ComfyUI. No extra Python dependencies beyond the ComfyUI core.
