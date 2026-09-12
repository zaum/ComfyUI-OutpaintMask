// Outpaint Mask Editor - fullscreen frame editor for the OutpaintMaskEditor node.
// Nodes 1 (LiteGraph canvas) and Nodes 2 (Vue) compatible.
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const VERSION = "1.18.1";
const NODE_NAME = "OutpaintMaskEditor";
const SNAP = 8;                  // frame dims snap to multiples of this
const EDGE_SNAP_PX = 10;         // screen-px tolerance for snapping to image edges
const HANDLE_PX = 18;            // handle hit tolerance (screen px)
const HANDLE_DRAW = 5;           // handle half-size drawn on screen (px)
const MIN_DIM = 64;              // smallest allowed frame side (px)
const MAX_DIM = 16384;           // largest allowed frame side (px)
const MAX_PAD = 16384;           // max |pad| per side (px); negative pad = crop
const FRAME_LINE = 1;            // frame border width (screen px, thin)
// The view always fits the whole frame (image + outpaint padding) so the
// full mask stays visible after every change. Pan with middle-mouse drag,
// zoom with the wheel (kept until the next frame change).
let gapPattern = null;           // cached neutral checkerboard brush

function getGapPattern(ctx) {
  // Neutral checkerboard for the gap between image and frame (no red tint).
  if (!gapPattern) {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const g = c.getContext("2d");
    g.fillStyle = "#333333";
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = "#3e3e3e";
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    gapPattern = ctx.createPattern(c, "repeat");
  }
  return gapPattern;
}

function fmtMP(v) {
  // Short MP readout with no long fractions ("2 MP", "1.5 MP").
  const n = Number(v);
  if (!Number.isFinite(n)) return "0 MP";
  let t = n.toFixed(2);
  t = t.replace(/\.?0+$/, "");
  if (t === "-0") t = "0";
  return t + " MP";
}
// MP cap range: diffusion models lose quality well above their native
// size (SD1.5 ~0.25-0.5 MP, SDXL ~1-1.5 MP, Flux ~1-2 MP).
// Slider stops track native model sizes: 0.26 = SD1.5 512^2, 0.59 = SD2.x
// 768^2, 1.05 = SDXL/SD3 1024^2, plus larger working sizes up to 8 MP
// (~2048^2 and beyond, e.g. for HiRes/upscale chains).
// Manual input allows the same headroom up to 8 MP (see MP_MAX_MANUAL).
// Lock (limit on) / unlock (limit off) SVG icons for the MP toggle.
const MP_LOCK_ICON = `<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-4 4v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4zm-2 4a2 2 0 1 1 4 0v3h-4V6zm2 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>`;
const MP_UNLOCK_ICON = `<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4zm0 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>`;

function renderMpIcon() {
  const ui = Editor.ui;
  if (!ui || !ui.mpOn) return;
  ui.mpOn.innerHTML = Editor.mpOn ? MP_LOCK_ICON : MP_UNLOCK_ICON;
  ui.mpOn.classList.toggle("on", Editor.mpOn);
}
const DEFAULT_MP = 2.0;
const DEFAULT_DPI = 300;           // DPI for pixel to millimeter conversion
const MM_PER_INCH = 25.4;
// Slider steps for the MP cap (slider stops at 4 MP, manual input up to 8).
// The first three stops are the EXACT native model sizes (512^2, 768^2,
// 1024^2): tick labels stay short via fmtMP ("0.26", "0.59", "1.05").
const MP_MAX_MANUAL = 8.0;
const MP_STEPS = [0.262144, 0.589824, 1.048576, 1.5, 2.0, 2.5, 3.0, 4.0, 6.0, 8.0];

// ---------------------------------------------------------------- CSS

const CSS = `
.opm-overlay{position:fixed;inset:0;z-index:2000000;background:#101010;display:flex;flex-direction:column;
  color:#ddd;font:13px/1.4 system-ui,Segoe UI,sans-serif;user-select:none;-webkit-user-select:none}
.opm-hidden{display:none !important}
.opm-topbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1b1b1b;
  border-bottom:1px solid #2c2c2c;flex-wrap:wrap;position:relative;z-index:5}
.opm-group{display:flex;align-items:center;gap:6px}
.opm-spacer{flex:1}
.opm-btn{background:#2a2a2a;border:1px solid #3c3c3c;color:#ddd;padding:6px 12px;border-radius:6px;
  cursor:pointer;font-size:13px}
.opm-btn.wide{min-width:74px}
.opm-btn:hover{background:#353535}
.opm-btn.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}
.opm-btn.primary:hover{background:#3f7cf0}
.opm-progress{height:3px;flex:none;background:#101010}
.opm-progress-fill{height:100%;width:0;background:linear-gradient(90deg,#2f6fed,#6ea8fe);
  transition:width .15s ease-out}
.opm-progress-fill.busy{width:100% !important;background:repeating-linear-gradient(90deg,
  #2f6fed 0 8px,#2456c4 8px 16px);animation:opm-slide 1s linear infinite;transition:none}
@keyframes opm-slide{to{background-position:16px 0}}
.opm-pill{background:#242424;border:1px solid #3c3c3c;color:#ccc;padding:5px 10px;border-radius:0;
  cursor:pointer;font-size:12.5px;margin-left:-1px;position:relative;white-space:nowrap}
.opm-pill:first-child{border-radius:4px 0 0 4px;margin-left:0}
.opm-pill:last-child{border-radius:0 4px 4px 0}
.opm-pill:hover{background:#303030;color:#eee;z-index:1}
.opm-pill.active{background:#2f6fed;color:#fff;border-color:#2f6fed;z-index:1}
.opm-num{width:74px;background:#141414;border:1px solid #3c3c3c;color:#eee;padding:5px 6px;
  border-radius:6px;font-size:13px}
.opm-label{color:#8a8a8a;font-size:12.5px}
.opm-mp-label{color:#d2d2d2;font-size:12.5px}
.opm-slider{width:110px;height:12px;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none;
  margin:0;align-self:center;position:relative;transform:translateY(-4px)}
.opm-slider::-webkit-slider-runnable-track{height:2px;background:#3c3c3c;border-radius:1px}
.opm-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:8px;height:8px;
  border-radius:50%;background:#2f6fed;border:none;margin-top:-3px}
.opm-slider::-moz-range-track{height:2px;background:#3c3c3c;border-radius:1px}
.opm-slider::-moz-range-thumb{width:8px;height:8px;border:none;border-radius:50%;background:#2f6fed}
.opm-slider-wrap{position:relative;display:inline-flex;align-items:center}
.opm-bubble{position:absolute;top:calc(100% + 16px);left:0;transform:translateX(-50%);
  background:#0f0f0f;border:1px solid #4a86e8;color:#eee;font-size:12px;padding:7px 12px;
  border-radius:6px;white-space:nowrap;z-index:50;pointer-events:none}
.opm-bubble::after{content:"";position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
  border:5px solid transparent;border-bottom-color:#4a86e8}
.opm-arrow{color:#fff;font-weight:700}
.opm-pill-group{display:flex;align-items:center;gap:0;flex-wrap:nowrap}
#opm-mp-num{width:56px}
#opm-dpi{width:64px}
.opm-slider:disabled{opacity:.4;cursor:default}
.opm-num:disabled{opacity:.4}
.opm-mp-toggle{display:flex;align-items:center;justify-content:center;width:30px;height:30px;
  background:#242424;border:1px solid #3c3c3c;border-radius:6px;cursor:pointer;flex:none;color:#999;
  padding:0}
.opm-mp-toggle:hover{background:#303030;color:#ccc}
.opm-mp-toggle.on{background:#2f6fed;border-color:#2f6fed;color:#fff}
.opm-mp-toggle svg{width:15px;height:15px;display:block;fill:currentColor}
.opm-sep{width:1px;height:22px;background:#333;margin:0 4px}
.opm-mid{flex:1;display:flex;min-height:0;min-width:0}
.opm-viewport{flex:1;position:relative;overflow:hidden;background:#141414;touch-action:none;min-width:0}
.opm-viewport canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.opm-side{width:136px;flex:none;background:#161616;border-left:1px solid #2c2c2c;
  display:flex;flex-direction:column;min-height:0}
.opm-side-title{padding:8px 10px 4px;color:#8a8a8a;font-size:12px;flex:none}
.opm-render-list{flex:1;overflow-y:auto;padding:4px 8px 10px;display:flex;
  flex-direction:column;gap:10px}
.opm-render-empty{color:#666;font-size:12px;padding:6px 2px;line-height:1.5}
.opm-thumb{position:relative;flex:none;cursor:pointer;border:2px solid transparent;
  border-radius:6px;overflow:visible;background:#0f0f0f}
.opm-thumb img{display:block;width:100%;height:auto;border-radius:4px}
.opm-thumb:hover{border-color:#4a86e8}
.opm-thumb.active{border-color:#2f6fed}
.opm-thumb-tag{position:absolute;left:4px;top:4px;background:rgba(0,0,0,.65);color:#ddd;
  font-size:11px;padding:1px 6px;border-radius:4px;pointer-events:none}
.opm-thumb-tag.final{background:rgba(31,122,51,.85);color:#fff}
.opm-thumb-actions{position:absolute;right:calc(100% + 6px);top:50%;transform:translateY(-50%);
  display:none;flex-direction:column;gap:6px;z-index:5}
.opm-thumb:hover .opm-thumb-actions,.opm-thumb:focus-within .opm-thumb-actions{display:flex}
.opm-thumb-act{width:28px;height:28px;border-radius:50%;border:1px solid #555;
  color:#fff;font-size:15px;line-height:1;cursor:pointer;display:flex;
  align-items:center;justify-content:center;padding:0}
.opm-thumb-accept{background:#1f7a33;border-color:#2ea34d}
.opm-thumb-accept:hover{background:#27a047}
.opm-thumb-drop{background:#8c2020;border-color:#c03a3a}
.opm-thumb-drop:hover{background:#b02828}
.opm-status{display:flex;align-items:center;gap:10px;padding:7px 14px;background:#1b1b1b;
  border-top:1px solid #2c2c2c;color:#bbb;font-size:12.5px}
.opm-status b{color:#8cf;font-weight:600}
.opm-status kbd{display:inline-block;padding:1px 4px;margin:0;font:600 11px/1.4 system-ui,Segoe UI,sans-serif;
  color:#8cf;background:#1e2a3a;border:1px solid #3a4a5a;border-radius:3px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 0 rgba(0,0,0,.4)}
.opm-zoom{color:#888}
.opm-hint{margin-left:auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.opm-hint span{white-space:nowrap}
.opm-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);background:#302028;
  color:#ffb3c0;border:1px solid #5a2a35;padding:8px 14px;border-radius:8px;z-index:2000001;
  font:13px system-ui,Segoe UI,sans-serif}
.opm-open-wrap{height:34px;min-height:34px;max-height:34px;overflow:hidden;display:flex;
  align-items:stretch;box-sizing:border-box;flex:none;width:100%}
.opm-open-btn{background:linear-gradient(#3a76d8,#2b62b8);color:#fff;border:1px solid #4a86e8;
  border-radius:6px;cursor:pointer;font-size:13px;width:100%;height:32px;min-height:32px;
  max-height:32px;box-sizing:border-box;flex:1;line-height:30px;padding:0 12px;white-space:nowrap}
.opm-open-btn:hover{filter:brightness(1.1)}
img.opm-tint{position:absolute;z-index:5;pointer-events:auto;cursor:pointer;border:none;outline:none;object-fit:contain;background:#0f0f0f}
.opm-preview-box{position:relative}
.opm-preview-paste{position:relative;z-index:20}
.opm-preview-paste.opm-extra-gap{margin-right:4px}
.opm-preview-paste.opm-busy{opacity:.5;cursor:wait}
.opm-preview-paste.opm-fallback{position:absolute;top:8px;z-index:20;opacity:0}
.opm-preview-box:hover .opm-preview-paste.opm-fallback,.opm-preview-paste.opm-fallback:focus-visible,.opm-preview-paste.opm-fallback.opm-busy{opacity:1}
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------- utils

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ceilSnap = (v) => Math.ceil(v / SNAP) * SNAP;
const floorSnap = (v) => Math.floor(v / SNAP) * SNAP;
const roundSnap = (v) => Math.round(v / SNAP) * SNAP;
// Snap a value to a target within a screen-px tolerance (used so frame edges
// "click" to the image edges from both the inside and the outside).
const snapTo = (v, target, tol) => Math.abs(v - target) <= tol ? target : v;

function mpFromWh(w, h) {
  return (w * h) / 1e6;
}

function parseState(raw) {
  const st = { v: 1, l: 0, t: 0, r: 0, b: 0, mp_on: true, mp: DEFAULT_MP, unit: "px", dpi: DEFAULT_DPI, render_pick: 0, render_drop: [] };
  try {
    const data = JSON.parse(raw || "{}");
    if (data && typeof data === "object") {
      for (const k of ["l", "t", "r", "b"]) {
        const v = Number(data[k]);
        // Pads may be negative: a negative pad means the frame cuts INSIDE
        // the image on that side, i.e. the node output is cropped there.
        if (Number.isFinite(v)) st[k] = clamp(Math.round(v), -MAX_PAD, MAX_PAD);
      }
      st.mp_on = data.mp_on !== false;
      const mp = Number(data.mp);
      if (Number.isFinite(mp) && mp > 0) st.mp = clamp(mp, 0.05, MP_MAX_MANUAL);
      // Display unit + DPI for the mm readout (backend ignores these keys).
      st.unit = data.unit === "mm" ? "mm" : "px";
      const dpi = Number(data.dpi);
      st.dpi = Number.isFinite(dpi) ? clamp(Math.round(dpi), 1, 2400) : DEFAULT_DPI;
      // Render gallery selection: accepted variant index + dropped batch
      // indices (backend merges the pick; missing keys mean "first").
      const pick = Number(data.render_pick);
      st.render_pick = Number.isFinite(pick) ? Math.max(0, Math.round(pick)) : 0;
      const drop = data.render_drop;
      st.render_drop = Array.isArray(drop)
        ? [...new Set(drop.map((v) => Math.max(0, Math.round(Number(v)))).filter((v) => Number.isFinite(v)))]
        : [];
    }
  } catch (e) {
    /* keep defaults */
  }
  return st;
}

function buildViewURL(ref, fresh) {
  if (!ref) return null;
  const p = new URLSearchParams({
    filename: ref.filename || "",
    subfolder: ref.subfolder || "",
    type: ref.type || "input",
  });
  if (fresh) p.set("_t", String(Date.now()));
  return api.apiURL("/view?" + p.toString());
}

function loadImageURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

function showToast(msg) {
  const t = document.createElement("div");
  t.className = "opm-toast";
  t.textContent = msg;
  // Stack multiple toasts so they never cover each other.
  const n = document.querySelectorAll(".opm-toast").length;
  t.style.bottom = `${64 + n * 44}px`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// Legacy = Nodes 1 (LiteGraph canvas) frontend: no [data-node-id] elements.
// Checked on every call: the Vue frontend may render its node containers
// after this extension loads, so a cached answer would stick wrongly.

// Legacy = Nodes 1 (LiteGraph canvas) frontend: no [data-node-id] elements.
function isLegacy() {
  return !document.querySelector("[data-node-id]");
}


// ---------------------------------------------------------------- editor

const Editor = {
  openFlag: false,
  node: null,
  img: null,
  W: 0,
  H: 0,
  mpOn: true,
  mp: DEFAULT_MP,
  unit: "px",
  dpi: DEFAULT_DPI,
  frame: { x: 0, y: 0, w: 0, h: 0 },
  scale: 1,
  fitScale: 1,
  offX: 0,
  offY: 0,
  drag: null,
  hover: null,
  // Render variant gallery session: kept sampler outputs ({batchIdx, url,
  // img}) + selected index (-1 = none). Rebuilt on every editor open.
  renders: [],
  renderSel: -1,
  // Final composite session: backend merged result ({url, img}) shown as
  // the gallery "Final" thumb; showFinal previews it on the workspace.
  renderFinal: null,
  showFinal: false,
  // One-shot cap flash: timestamp until which the frame shows solid amber.
  capFlashUntil: 0,
  _wasAtCap: false,
  _prevArea: 0,

  fmtLen(px) {
    // Length readout in the active unit (internal model is always pixels).
    if (this.unit === "mm") return (px * MM_PER_INCH / this.dpi).toFixed(1) + " mm";
    return Math.round(px) + " px";
  },

  buildDom() {
    if (this.ui) return;
    injectCss();
    const overlay = document.createElement("div");
    overlay.className = "opm-overlay opm-hidden";
    const pills = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"]
      .map((p) => `<button class="opm-pill" data-pill="${p}">${p}</button>`)
      .join("");
    const mpOpts = MP_STEPS.map((v, i) => `<option value="${i}" label="${fmtMP(v)}">`).join("");
    overlay.innerHTML = `
      <div class="opm-topbar">
        <div class="opm-group">
          <button class="opm-btn" id="opm-reset" title="Reset frame to a centered default">Reset</button>
        </div>
        <div class="opm-pill-group">${pills}</div>
        <div class="opm-sep"></div>
        <div class="opm-group">
          <span class="opm-mp-label">Limit Megapixel</span>
          <button class="opm-mp-toggle" id="opm-mp-on" type="button" title="Megapixel limit (click: on/off)"></button>
          <span class="opm-slider-wrap">
            <input type="range" id="opm-mp-slider" class="opm-slider" list="opm-mp-steps" min="0" max="${MP_STEPS.length - 1}" step="1">
            <span class="opm-bubble opm-hidden" id="opm-mp-bubble"></span>
          </span>
          <datalist id="opm-mp-steps">${mpOpts}</datalist>
          <input type="number" id="opm-mp-num" class="opm-num" min="0.05" max="8" step="0.25" title="Megapixel limit (editable)">
        </div>
        <div class="opm-sep"></div>
        <div class="opm-group">
          <span class="opm-label">W</span><input type="number" id="opm-w" class="opm-num" step="8" min="${MIN_DIM}">
          <span class="opm-label">×</span>
          <span class="opm-label">H</span><input type="number" id="opm-h" class="opm-num" step="8" min="${MIN_DIM}">
          <div class="opm-pill-group">
            <button class="opm-pill" data-unit="px">px</button><button class="opm-pill" data-unit="mm">mm</button>
          </div>
          <input type="number" id="opm-dpi" class="opm-num" min="1" max="2400" step="1" title="DPI for pixel to millimeter conversion">
          <span class="opm-label">DPI</span>
        </div>
        <div class="opm-spacer"></div>
        <div class="opm-group">
          <button class="opm-btn wide" id="opm-cancel" title="Discard changes (Esc)">Cancel</button>
          <button class="opm-btn primary wide" id="opm-ok" title="Apply mask (Enter)">OK</button>
          <button class="opm-btn primary wide" id="opm-render" title="Queue the current workflow (renders the tile into the gallery)">Render</button>
        </div>
      </div>
      <div class="opm-progress opm-hidden" id="opm-progress"><div class="opm-progress-fill" id="opm-progress-fill"></div></div>
      <div class="opm-mid">
        <div class="opm-viewport" id="opm-viewport"><canvas id="opm-canvas"></canvas></div>
        <div class="opm-side" id="opm-side">
          <div class="opm-side-title">Renders</div>
          <div class="opm-render-list" id="opm-render-list"></div>
        </div>
      </div>
      <div class="opm-status">
        <span id="opm-info-img"></span>
        <span class="opm-arrow">→</span>
        <span id="opm-info-frame"></span>
        <span class="opm-hint">
          <span><kbd>Drag</kbd> middle: move</span>
          <span><kbd>Corner</kbd>: resize</span>
          <span><kbd>Shift</kbd>+<kbd>Corner</kbd>: free</span>
          <span><kbd>Esc</kbd>: cancel</span>
          <span><kbd>Enter</kbd>: OK</span>
        </span>
      </div>`;
    document.body.appendChild(overlay);

    const vp = overlay.querySelector("#opm-viewport");
    const canvas = overlay.querySelector("#opm-canvas");
    this.ui = {
      overlay,
      vp,
      canvas,
      pills: [...overlay.querySelectorAll('.opm-pill[data-pill]')],
      unitPills: [...overlay.querySelectorAll('.opm-pill[data-unit]')],
      dpiIn: overlay.querySelector("#opm-dpi"),
      mpOn: overlay.querySelector("#opm-mp-on"),
      mpSlider: overlay.querySelector("#opm-mp-slider"),
      mpBubble: overlay.querySelector("#opm-mp-bubble"),
      mpNum: overlay.querySelector("#opm-mp-num"),
      wIn: overlay.querySelector("#opm-w"),
      hIn: overlay.querySelector("#opm-h"),
      resetBtn: overlay.querySelector("#opm-reset"),
      renderBtn: overlay.querySelector("#opm-render"),
      cancelBtn: overlay.querySelector("#opm-cancel"),
      okBtn: overlay.querySelector("#opm-ok"),
      infoImg: overlay.querySelector("#opm-info-img"),
      infoFrame: overlay.querySelector("#opm-info-frame"),
      renderList: overlay.querySelector("#opm-render-list"),
      progressWrap: overlay.querySelector("#opm-progress"),
      progressFill: overlay.querySelector("#opm-progress-fill"),
    };
    this.wireEvents();
  },

  showProgressBusy() {
    // Thin indeterminate strip: a queue is running, no step numbers yet.
    const ui = this.ui;
    if (!ui || !ui.progressWrap || !ui.progressFill) return;
    ui.progressWrap.classList.remove("opm-hidden");
    ui.progressFill.classList.add("busy");
  },

  setProgress(value, max) {
    const ui = this.ui;
    if (!ui || !ui.progressWrap || !ui.progressFill) return;
    ui.progressWrap.classList.remove("opm-hidden");
    ui.progressFill.classList.remove("busy");
    const v = Number(value);
    const m = Number(max);
    const pct = Number.isFinite(v) && Number.isFinite(m) && m > 0
      ? Math.max(0, Math.min(100, (v / m) * 100))
      : 0;
    ui.progressFill.style.width = `${pct}%`;
  },

  hideProgress() {
    const ui = this.ui;
    if (!ui || !ui.progressWrap || !ui.progressFill) return;
    ui.progressWrap.classList.add("opm-hidden");
    ui.progressFill.classList.remove("busy");
    ui.progressFill.style.width = "0";
  },

  wireEvents() {
    const ui = this.ui;
    ui.overlay.addEventListener("contextmenu", (e) => e.preventDefault());

    ui.pills.forEach((b) =>
      b.addEventListener("click", () => {
        const [a, c] = String(b.dataset.pill).split(":").map(Number);
        this.applyPreset(a / c);
      })
    );

    (ui.unitPills || []).forEach((b) =>
      b.addEventListener("click", () => {
        this.unit = b.dataset.unit === "mm" ? "mm" : "px";
        this.syncToolbar();
      })
    );

    ui.dpiIn.addEventListener("change", () => {
      let v = parseFloat(ui.dpiIn.value);
      if (!Number.isFinite(v)) v = DEFAULT_DPI;
      this.dpi = clamp(Math.round(v), 1, 2400);
      ui.dpiIn.value = this.dpi;
      this.syncToolbar();
    });

    ui.mpOn.addEventListener("click", () => {
      this.mpOn = !this.mpOn;
      if (this.mpOn) this.clampToMP();
      renderMpIcon();
      this.syncToolbar();
      this.commit();
    });

    ui.mpSlider.addEventListener("input", () => {
      this.mp = MP_STEPS[Number(ui.mpSlider.value)] || DEFAULT_MP;
      ui.mpNum.value = this.mp;
      if (this.mpOn) this.clampToMP();
      this.syncToolbar();
      this.showMpBubble();
      this.commit();
    });
    ui.mpSlider.addEventListener("mouseenter", () => this.showMpBubble());
    ui.mpSlider.addEventListener("mouseleave", () => this.hideMpBubble());
    ui.mpSlider.addEventListener("focus", () => this.showMpBubble());
    ui.mpSlider.addEventListener("blur", () => this.hideMpBubble());

    ui.mpNum.addEventListener("change", () => {
      let v = parseFloat(ui.mpNum.value);
      if (!Number.isFinite(v)) v = DEFAULT_MP;
      this.mp = clamp(v, 0.05, MP_MAX_MANUAL);
      ui.mpNum.value = this.mp;
      if (this.mpOn) this.clampToMP();
      this.syncToolbar();
      this.commit();
    });

    ui.wIn.addEventListener("change", () => this.setManualWH());
    ui.hIn.addEventListener("change", () => this.setManualWH());
    // Dirty tracking: typing marks the field so mouse drags don't clobber
    // uncommitted text; Enter/blur commits (change) and clears the mark.
    ui.wIn.addEventListener("input", () => {
      ui.wIn._opmDirty = true;
    });
    ui.hIn.addEventListener("input", () => {
      ui.hIn._opmDirty = true;
    });
    ui.wIn.addEventListener("blur", () => {
      ui.wIn._opmDirty = false;
    });
    ui.hIn.addEventListener("blur", () => {
      ui.hIn._opmDirty = false;
    });

    ui.resetBtn.addEventListener("click", () => this.resetFrame());
    ui.renderBtn.addEventListener("click", () => queueRender(this.node));
    ui.cancelBtn.addEventListener("click", () => this.close());
    ui.okBtn.addEventListener("click", () => this.save());

    this._onKeyDown = (e) => {
      if (!this.openFlag) return;
      const tag = (e.target && e.target.tagName) || "";
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        this.save();
      }
    };
    document.addEventListener("keydown", this._onKeyDown);

    // Drag + pan handling: pointer events on the viewport so mouse drags
    // always reach the editor (even when the canvas element itself is not
    // the event target or has a stale size).
    ui.vp.addEventListener("pointerdown", (e) => this.onDown(e));
    ui.vp.addEventListener("pointermove", (e) => this.onMove(e));
    ui.vp.addEventListener("pointerup", () => this.onUp());
    ui.vp.addEventListener("pointercancel", () => this.onUp());
    ui.vp.addEventListener("pointerleave", () => {
      this.hover = null;
    });
    // Keep panning/dragging alive when the pointer leaves the viewport.
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", () => this.onUp());
    window.addEventListener("pointercancel", () => this.onUp());
    // Middle-click would trigger browser autoscroll: suppress it here.
    ui.vp.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    ui.vp.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    // Refit after layout settles (fonts, scrollbars) so the first frame is
    // centered instead of clipped.
    window.addEventListener("resize", () => {
      if (this.openFlag) this.recomputeView();
    });

    // Wheel zoom anchored to the viewport center so the whole picture stays
    // put instead of flying away from the editor.
    ui.vp.addEventListener(
      "wheel",
      (e) => {
        if (!this.openFlag) return;
        e.preventDefault();
        const rect = ui.vp.getBoundingClientRect();
        const px = rect.width / 2;
        const py = rect.height / 2;
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const ix = (px - this.offX) / this.scale;
        const iy = (py - this.offY) / this.scale;
        const s2 = clamp(this.scale * f, this.fitScale * 0.3, this.fitScale * 12);
        this.scale = s2;
        this.offX = px - ix * s2;
        this.offY = py - iy * s2;
        this.syncToolbar();
      },
      { passive: false }
    );
  },


  // ------------------------------------------------------------ open / close

  async open(node) {
    try {
      this.buildDom();
    } catch (e) {
      console.error("[OutpaintMask] editor UI build failed:", e);
      showToast("Editor failed to open (UI error - see console).");
      return;
    }
    let img = null;
    try {
      img = await this.getSource(node);
    } catch (e) {
      img = null;
    }
    if (!img) {
      showToast("No image loaded yet - run the node (or select an image) first.");
      return;
    }
    this.node = node;
    this.img = img;
    this.W = img.naturalWidth;
    this.H = img.naturalHeight;

    const st = this.getState(node);
    this.mpOn = st.mp_on;
    this.mp = st.mp;
    this.unit = st.unit === "mm" ? "mm" : "px";
    this.dpi = st.dpi || DEFAULT_DPI;

    // Restore the frame from the saved paddings; fall back to a reset frame.
    const f = {
      x: -st.l,
      y: -st.t,
      w: this.W + st.l + st.r,
      h: this.H + st.t + st.b,
    };
    const okPads =
      Math.abs(f.x) <= MAX_PAD && Math.abs(f.y) <= MAX_PAD &&
      Math.abs(f.x + f.w - this.W) <= MAX_PAD && Math.abs(f.y + f.h - this.H) <= MAX_PAD;
    if (f.w >= MIN_DIM && f.h >= MIN_DIM && f.w <= MAX_DIM && f.h <= MAX_DIM && okPads) {
      this.frame = f;
      this.boundsClamp(this.frame);
      if (this.mpOn) this.clampToMP();
    } else {
      this.resetFrame();
    }

    // Render variant gallery session (sampler output batch, if any).
    this.renders = [];
    this.renderSel = -1;
    this.loadRenders(node);

    this.ui.overlay.classList.remove("opm-hidden");
    this.openFlag = true;
    this.drag = null;
    renderMpIcon();
    this.syncToolbar();
    // The overlay just became visible: layout is only valid now, so fit the
    // view on the next frames (twice, in case scrollbars shift sizes).
    this.recomputeView();
    requestAnimationFrame(() => {
      if (!this.openFlag) return;
      this.recomputeView();
      this.syncToolbar();
    });
    setTimeout(() => {
      if (!this.openFlag) return;
      this.recomputeView();
      this.syncToolbar();
    }, 60);
    this.commit();
    this.startLoop();
  },

  close() {
    this.openFlag = false;
    this.drag = null;
    this.hover = null;
    this.capFlashUntil = 0;
    this.renders = [];
    this.renderSel = -1;
    this.renderFinal = null;
    this.showFinal = false;
    this.hideProgress();
    if (this.ui) this.ui.overlay.classList.add("opm-hidden");
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  },

  getState(node) {
    let raw = node._opm_state;
    if (typeof raw !== "string" || !raw.trim()) {
      const w = (node.widgets || []).find((x) => x.name === "outpaint_state");
      raw = w ? w.value : "{}";
    }
    return parseState(raw);
  },

  setState(node, st) {
    node._opm_state = JSON.stringify(st);
    const w = (node.widgets || []).find((x) => x.name === "outpaint_state");
    if (w) w.value = node._opm_state;
  },

  async getSource(node) {
    // 1) Cached source ref pushed by the Python node via the executed event.
    let ref = node._opm_source || null;
    // 2) The image dropdown widget (file-based path like "sub/dir/file.png").
    if (!ref) {
      const w = (node.widgets || []).find((x) => x.name === "image");
      if (w && typeof w.value === "string" && w.value) {
        const parts = w.value.split("/");
        ref = { filename: parts[parts.length - 1], subfolder: parts.slice(0, -1).join("/"), type: "input" };
      }
    }
    if (!ref || !ref.filename) return null;
    return await loadImageURL(buildViewURL(ref, true));
  },

  // ------------------------------------------------------------ view

  recomputeView() {
    const vp = this.ui.vp;
    const vw = Math.max(100, vp.clientWidth);
    const vh = Math.max(100, vp.clientHeight);
    // Fit the whole frame (image + outpaint padding) with a small margin so
    // the full mask is always visible and the frame edges stay grabbable.
    const f = this.frame;
    const hasFrame = f && f.w > 0 && f.h > 0;
    const x0 = hasFrame ? Math.min(0, f.x) : 0;
    const y0 = hasFrame ? Math.min(0, f.y) : 0;
    const x1 = hasFrame ? Math.max(this.W, f.x + f.w) : this.W;
    const y1 = hasFrame ? Math.max(this.H, f.y + f.h) : this.H;
    const bw = Math.max(8, x1 - x0);
    const bh = Math.max(8, y1 - y0);
    const fit = Math.min((vw * 0.88) / bw, (vh * 0.88) / bh);
    // Wheel-zoom limits stay anchored to the image fit (stable reference).
    this.fitScale = Math.min((vw * 0.88) / this.W, (vh * 0.88) / this.H);
    this.scale = fit;
    this.offX = vw / 2 - ((x0 + x1) / 2) * fit;
    this.offY = vh / 2 - ((y0 + y1) / 2) * fit;
  },

  commit() {
    // Called whenever the frame changes "transactionally": refit the view so
    // the whole frame stays visible, and refresh the toolbar/status. During
    // drags this is NOT called so the viewport stays perfectly still.
    this.recomputeView();
    this.syncToolbar();
  },

  syncToolbar() {
    const ui = this.ui;
    if (!ui) return;
    const f = this.frame;
    renderMpIcon();
    // Nearest slider step for the current MP value.
    let best = 0;
    for (let i = 0; i < MP_STEPS.length; i++) {
      if (Math.abs(MP_STEPS[i] - this.mp) < Math.abs(MP_STEPS[best] - this.mp)) best = i;
    }
    ui.mpSlider.value = String(best);
    if (document.activeElement !== ui.mpNum) ui.mpNum.value = Math.round(this.mp * 100) / 100;
    // W/H fields follow the active unit (mm values convert back on edit).
    // A merely focused (not typed-in) field still tracks mouse drags; a
    // field with uncommitted typing keeps the typed text until Enter/blur.
    const toField = (px) => (this.unit === "mm" ? (px * MM_PER_INCH / this.dpi).toFixed(1) : Math.round(px));
    if (document.activeElement !== ui.wIn || !ui.wIn._opmDirty) ui.wIn.value = toField(f.w);
    if (document.activeElement !== ui.hIn || !ui.hIn._opmDirty) ui.hIn.value = toField(f.h);
    // Spinner steps stay on the 8 px grid (one VAE cell): 8 px in px mode,
    // the 8 px equivalent in mm mode. Typed values snap on change anyway.
    const mmStep = String(Math.max(0.01, Math.round(((8 * MM_PER_INCH) / this.dpi) * 100) / 100));
    ui.wIn.step = this.unit === "mm" ? mmStep : "8";
    ui.hIn.step = this.unit === "mm" ? mmStep : "8";
    if (ui.unitPills) ui.unitPills.forEach((b) => b.classList.toggle("active", b.dataset.unit === this.unit));
    if (document.activeElement !== ui.dpiIn) ui.dpiIn.value = this.dpi;
    ui.dpiIn.disabled = this.unit !== "mm";
    ui.infoImg.innerHTML = `Input <b>${this.fmtLen(this.W)} × ${this.fmtLen(this.H)}</b>`;
    // Output = the node/backend canvas: frame size snapped up to 8 px.
    const cw = ceilSnap(Math.max(8, Math.round(f.w)));
    const ch = ceilSnap(Math.max(8, Math.round(f.h)));
    // Short MP readout: no long fraction tails.
    ui.infoFrame.innerHTML = `Output <b>${this.fmtLen(cw)} × ${this.fmtLen(ch)}</b> · ${fmtMP(mpFromWh(cw, ch))}`;
    ui.mpSlider.disabled = !this.mpOn;
    ui.mpNum.disabled = !this.mpOn;
    this.updatePresetHighlight();
    this.updateMpBubble();
  },

  showMpBubble() {
    this.updateMpBubble();
    if (this.ui && this.ui.mpBubble) this.ui.mpBubble.classList.remove("opm-hidden");
  },

  hideMpBubble() {
    if (this.ui && this.ui.mpBubble) this.ui.mpBubble.classList.add("opm-hidden");
  },

  updateMpBubble() {
    // Triangular bubble under the slider thumb: only the 1:1 pixel size the
    // MP cap means (largest square that fits the budget: floor, so e.g. the
    // 1024^2 stop reads exactly 1024x1024), no other data.
    const ui = this.ui;
    if (!ui || !ui.mpBubble || !ui.mpSlider) return;
    const side = Math.floor(Math.sqrt(Math.max(0, this.mp) * 1e6));
    ui.mpBubble.textContent = `${side}×${side}`;
    const s = ui.mpSlider;
    const min = Number(s.min || 0);
    const max = Number(s.max || 0);
    const pct = (Number(s.value) - min) / Math.max(1e-6, max - min);
    // Center exactly on the thumb: the thumb middle travels only between
    // half and full-minus-half thumb width (THUMB must match the CSS thumb
    // size), otherwise the bubble drifts sideways as the slider moves.
    const THUMB = 8;
    ui.mpBubble.style.left = `${THUMB / 2 + pct * Math.max(0, s.clientWidth - THUMB)}px`;
    ui.mpBubble.style.top = ""; // CSS places it below the thumb
  },


  // ------------------------------------------------------------ draw

  startLoop() {
    const tick = () => {
      if (!this.openFlag) return;
      this.draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  },

  toImage(e) {
    const rect = this.ui.vp.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return { sx, sy, ix: (sx - this.offX) / this.scale, iy: (sy - this.offY) / this.scale };
  },

  handleList() {
    const f = this.frame;
    return [
      { id: "nw", x: f.x, y: f.y, cx: "nwse-resize" },
      { id: "n", x: f.x + f.w / 2, y: f.y, cx: "ns-resize" },
      { id: "ne", x: f.x + f.w, y: f.y, cx: "nesw-resize" },
      { id: "e", x: f.x + f.w, y: f.y + f.h / 2, cx: "ew-resize" },
      { id: "se", x: f.x + f.w, y: f.y + f.h, cx: "nwse-resize" },
      { id: "s", x: f.x + f.w / 2, y: f.y + f.h, cx: "ns-resize" },
      { id: "sw", x: f.x, y: f.y + f.h, cx: "nesw-resize" },
      { id: "w", x: f.x, y: f.y + f.h / 2, cx: "ew-resize" },
    ];
  },

  draw() {
    const ui = this.ui;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, ui.vp.clientWidth);
    const chh = Math.max(1, ui.vp.clientHeight);
    if (ui.canvas.width !== Math.round(cw * dpr) || ui.canvas.height !== Math.round(chh * dpr)) {
      ui.canvas.width = Math.round(cw * dpr);
      ui.canvas.height = Math.round(chh * dpr);
    }
    const ctx = ui.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, cw, chh);

    const s = this.scale;
    const X = (v) => this.offX + v * s;
    const Y = (v) => this.offY + v * s;
    const f = this.frame;

    // Outpaint area: neutral checkerboard brush (no red). The image is drawn
    // on top afterwards, so the texture only shows in the padding.
    ctx.fillStyle = getGapPattern(ctx);
    ctx.fillRect(X(f.x), Y(f.y), f.w * s, f.h * s);

    // Original image.
    ctx.drawImage(this.img, X(0), Y(0), this.W * s, this.H * s);

    // Final composite preview: the backend merge result on the full canvas
    // (its origin sits (tx,ty) left/above the tile origin). Otherwise the
    // selected render variant: the tile pasted at its box, then the source
    // re-pasted over its own rect, so ONLY the outpaint part of the variant
    // shows (original pixels stay intact).
    const fin = this.showFinal && this.renderFinal ? this.renderFinal.img : null;
    if (fin && fin.naturalWidth > 0) {
      const tx = Math.max(0, f.x);
      const ty = Math.max(0, f.y);
      ctx.drawImage(fin, X(f.x - tx), Y(f.y - ty), fin.naturalWidth * s, fin.naturalHeight * s);
    } else {
      const vsel = this.renderSel;
      const vr = vsel >= 0 && vsel < this.renders.length ? this.renders[vsel] : null;
      if (vr && vr.img && vr.img.naturalWidth > 0) {
        ctx.drawImage(vr.img, X(f.x), Y(f.y), f.w * s, f.h * s);
        const lx = -f.x;
        const ly = -f.y;
        const x0 = Math.max(0, -lx);
        const y0 = Math.max(0, -ly);
        const x1 = Math.min(this.W, f.w - lx);
        const y1 = Math.min(this.H, f.h - ly);
        if (x1 > x0 && y1 > y0) {
          ctx.drawImage(
            this.img, x0, y0, x1 - x0, y1 - y0,
            X(lx + x0), Y(ly + y0), (x1 - x0) * s, (y1 - y0) * s
          );
        }
      }
    }

    // Frame border: a manual resize growing into the MP cap fires ONE short
    // solid-amber flash (a single blink, never repeating). Otherwise thin
    // blue, with snapped sides highlighted while the mouse button is held.
    const flashing = performance.now() < this.capFlashUntil;
    if (flashing) {
      ctx.strokeStyle = "rgba(255, 176, 32, 0.95)";
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle = "rgba(95, 155, 255, 0.95)";
      ctx.lineWidth = FRAME_LINE;
    }
    ctx.strokeRect(X(f.x) - 0.5, Y(f.y) - 0.5, f.w * s + 1, f.h * s + 1);
    if (!flashing && this.drag && this.drag.f0) {
      // Snapped sides glow strong blue while held: only sides that actually
      // moved during this drag and now sit on an image edge/center line.
      const tol = EDGE_SNAP_PX / this.scale;
      const f0 = this.drag.f0;
      const near = (v, t) => Math.abs(v - t) <= tol;
      const moved = (a, b) => Math.abs(a - b) > 0.5;
      const vLine = (x) => near(x, 0) || near(x, this.W) || near(x, this.W / 2);
      const hLine = (y) => near(y, 0) || near(y, this.H) || near(y, this.H / 2);
      const L = f.x;
      const R = f.x + f.w;
      const T = f.y;
      const B = f.y + f.h;
      const L0 = f0.x;
      const R0 = f0.x + f0.w;
      const T0 = f0.y;
      const B0 = f0.y + f0.h;
      ctx.strokeStyle = "#2f7cf0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      let guideV = false;
      let guideH = false;
      if (moved(L, L0) && vLine(L)) {
        ctx.moveTo(X(L), Y(T));
        ctx.lineTo(X(L), Y(B));
        if (near(L, this.W / 2)) guideV = true;
      }
      if (moved(R, R0) && vLine(R)) {
        ctx.moveTo(X(R), Y(T));
        ctx.lineTo(X(R), Y(B));
        if (near(R, this.W / 2)) guideV = true;
      }
      if (moved(T, T0) && hLine(T)) {
        ctx.moveTo(X(L), Y(T));
        ctx.lineTo(X(R), Y(T));
        if (near(T, this.H / 2)) guideH = true;
      }
      if (moved(B, B0) && hLine(B)) {
        ctx.moveTo(X(L), Y(B));
        ctx.lineTo(X(R), Y(B));
        if (near(B, this.H / 2)) guideH = true;
      }
      // Frame center parked exactly on the image center (move snap): full
      // crosshair even though no side sits on a center line.
      if (this.drag.mode === "move") {
        const C = f.x + f.w / 2;
        const D = f.y + f.h / 2;
        if (near(C, this.W / 2) && near(D, this.H / 2)) {
          guideV = true;
          guideH = true;
        }
      }
      ctx.stroke();
      // Center guides: full-height / full-width dashed blue lines while a
      // snapped side sits on the image center line.
      if (guideV || guideH) {
        ctx.strokeStyle = "rgba(47, 124, 240, 0.8)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (guideV) {
          ctx.moveTo(X(this.W / 2), Y(0));
          ctx.lineTo(X(this.W / 2), Y(this.H));
        }
        if (guideH) {
          ctx.moveTo(X(0), Y(this.H / 2));
          ctx.lineTo(X(this.W), Y(this.H / 2));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // In-frame size readouts (gap labels + size chip) show while the cursor
    // is inside the frame, and ALWAYS during a resize drag (the cursor sits
    // on the handle then, i.e. outside the dead zone below, but the numbers
    // are exactly what the user needs while sizing the mask).
    // A small margin (dead zone) just inside the edges prevents the readouts
    // from appearing when the cursor is exactly on the frame border, which
    // avoids the "villanás" / flash of the frame data. A second small margin
    // OUTSIDE the frame keeps the hover valid a little around it, so the
    // numbers stay on while aiming at the handles from the outside.
    const hv = this.hover;
    const margin = 6;
    const outer = 12;
    const resizing = !!this.drag && this.drag.mode !== "pan" && this.drag.mode !== "move";
    const inside = !!hv &&
      hv.ix >= f.x && hv.ix <= f.x + f.w && hv.iy >= f.y && hv.iy <= f.y + f.h;
    const deepInside = !!hv &&
      hv.ix > f.x + margin && hv.ix < f.x + f.w - margin &&
      hv.iy > f.y + margin && hv.iy < f.y + f.h - margin;
    const nearOutside = !!hv && !inside &&
      hv.ix > f.x - outer && hv.ix < f.x + f.w + outer &&
      hv.iy > f.y - outer && hv.iy < f.y + f.h + outer;
    const showDims = resizing || deepInside || nearOutside;

    // Gap labels with faint dotted guide lines: the line runs from the image
    // edge to the frame edge and is interrupted by the number in the middle
    // (vertical for the top/bottom gaps, horizontal for the left/right).
    ctx.font = "12px system-ui, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const gaps = [
      { v: Math.round(-f.y), a0: 0, a1: f.y, fixed: f.x + f.w / 2, vert: true },
      { v: Math.round(f.y + f.h - this.H), a0: this.H, a1: f.y + f.h, fixed: f.x + f.w / 2, vert: true },
      { v: Math.round(-f.x), a0: 0, a1: f.x, fixed: f.y + f.h / 2, vert: false },
      { v: Math.round(f.x + f.w - this.W), a0: this.W, a1: f.x + f.w, fixed: f.y + f.h / 2, vert: false },
    ];
    ctx.strokeStyle = "rgba(220, 220, 220, 0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    if (showDims) for (const g of gaps) {
      const label = this.fmtLen(g.v);
      if (Math.abs(g.v) * s <= 40) continue;
      const mid = (g.a0 + g.a1) / 2;
      if (g.vert) {
        const x = X(g.fixed);
        const yMid = Y(mid);
        ctx.fillStyle = "#e6e6e6";
        ctx.fillText(label, x, yMid);
        const clear = 9; // half text height + padding
        ctx.beginPath();
        ctx.moveTo(x, Y(g.a0));
        ctx.lineTo(x, yMid - clear);
        ctx.moveTo(x, yMid + clear);
        ctx.lineTo(x, Y(g.a1));
        ctx.stroke();
      } else {
        const y = Y(g.fixed);
        const xMid = X(mid);
        ctx.fillStyle = "#e6e6e6";
        ctx.fillText(label, xMid, y);
        const halfText = ctx.measureText(label).width / 2 + 5;
        ctx.beginPath();
        ctx.moveTo(X(g.a0), y);
        ctx.lineTo(xMid - halfText, y);
        ctx.moveTo(xMid + halfText, y);
        ctx.lineTo(X(g.a1), y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.textBaseline = "alphabetic";

    // Frame size chip at the bottom center of the frame border (same rule
    // as the gap labels: cursor inside, or any resize drag in progress).
    if (showDims) {
      const label = `${this.fmtLen(f.w)} × ${this.fmtLen(f.h)}`;
      const lw = ctx.measureText(label).width + 14;
      let ly = Y(f.y + f.h) + 14;
      if (ly + 18 > chh) ly = Y(f.y + f.h) - 22;
      ctx.fillStyle = flashing ? "rgba(80, 52, 8, 0.85)" : "rgba(0, 0, 0, 0.75)";
      ctx.fillRect(X(f.x) + (f.w * s - lw) / 2, ly, lw, 18);
      ctx.fillStyle = "#eee";
      // Centered in the black chip (middle baseline, centered row).
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, X(f.x) + (f.w * s) / 2, ly + 9);
      ctx.textBaseline = "alphabetic";
    }

    // Handles: plain white squares WITHOUT an outline, drawn at a constant
    // screen size so they stay grabbable at any zoom level.
    const hs = HANDLE_DRAW;
    for (const hpos of this.handleList()) {
      const hx = X(hpos.x);
      const hy = Y(hpos.y);
      ctx.fillStyle = "#fff";
      ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
    }
  },


  // ------------------------------------------------------------ interaction

  maxDimFor(h) {
    // Largest frame width allowed by the MP cap given the other side = h.
    // Hard wall during every drag: the frame can never exceed the cap.
    if (!this.mpOn) return MAX_DIM;
    return Math.min(MAX_DIM, floorSnap((this.mp * 1e6) / Math.max(1, h)));
  },

  maxDimForW(w) {
    if (!this.mpOn) return MAX_DIM;
    return Math.min(MAX_DIM, floorSnap((this.mp * 1e6) / Math.max(1, w)));
  },

  boundsClamp(f) {
    // Crop is allowed (negative pads), but the frame and the image must
    // always touch or overlap: the frame can never leave the image fully.
    const minS = ceilSnap(MIN_DIM);
    f.w = clamp(f.w, minS, MAX_DIM);
    f.h = clamp(f.h, minS, MAX_DIM);
    const W = this.W;
    const H = this.H;
    // Left edge at most at the image right edge (touch), right edge at
    // least at the image left edge (touch); same vertically. Pads capped.
    f.x = clamp(f.x, Math.max(-f.w, -MAX_PAD), Math.min(W, MAX_PAD));
    f.y = clamp(f.y, Math.max(-f.h, -MAX_PAD), Math.min(H, MAX_PAD));
    return f;
  },

  clampToMP() {
    // Shrink the frame proportionally until it fits the MP cap (keep the
    // current aspect ratio AND center: the position stays put). Never below
    // the minimum size.
    const f = this.frame;
    if (!this.mpOn) return;
    const minS = ceilSnap(MIN_DIM);
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    let guard = 0;
    while (f.w * f.h > this.mp * 1e6 && guard++ < 60) {
      const a = f.w / f.h;
      const sc = Math.sqrt((this.mp * 1e6) / (f.w * f.h)) * 0.999;
      let w = roundSnap(f.w * sc);
      let h = roundSnap(w / a);
      w = Math.max(minS, Math.max(SNAP, w));
      h = Math.max(minS, Math.max(SNAP, h));
      if (w === f.w && h === f.h) break;
      f.w = w;
      f.h = h;
      if (w >= MAX_DIM || h >= MAX_DIM) break;
    }
    f.x = Math.round(cx - f.w / 2);
    f.y = Math.round(cy - f.h / 2);
    this.boundsClamp(f);
  },

  onDown(e) {
    if (!this.openFlag) return;
    const btn = e.button !== undefined ? e.button : 0;
    if (btn !== 0 && btn !== 1) return;
    const p = this.toImage(e);
    const tol = HANDLE_PX / this.scale;
    // Handle hit-test in image-space with a screen-px tolerance.
    // Corners first (they overlap edge midpoints), then edges.
    const handles = this.handleList();
    handles.sort((a, b) => b.id.length - a.id.length);
    let hit = null;
    for (const hpos of handles) {
      if (Math.abs(p.ix - hpos.x) <= tol && Math.abs(p.iy - hpos.y) <= tol) {
        hit = hpos.id;
        break;
      }
    }
    const f = this.frame;
    const inside =
      p.ix >= f.x && p.ix <= f.x + f.w && p.iy >= f.y && p.iy <= f.y + f.h;
    // Empty click (outside frame and handles): pan the canvas instead of
    // doing nothing, so the content can always be pulled back into view.
    // Middle mouse always pans, wherever the press happens.
    const wantPan = btn === 1;
    // Cap-flash edge tracking: fires only when a manual resize grows into
    // the limit (presets/sliders/typing never flash).
    this._prevArea = f.w * f.h;
    this._wasAtCap = this.mpOn && this._prevArea >= this.mp * 1e6 * 0.995;
    this.drag = {
      mode: wantPan ? "pan" : hit || (inside ? "move" : "pan"),
      startIx: p.ix,
      startIy: p.iy,
      startOffX: this.offX,
      startOffY: this.offY,
      startSx: p.sx,
      startSy: p.sy,
      f0: { ...f },
    };
    try {
      this.ui.vp.setPointerCapture?.(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  },

  onMove(e) {
    if (!this.openFlag) return;
    const p = this.toImage(e);
    // Hover position drives the in-frame size readouts (gap labels + chip).
    this.hover = { ix: p.ix, iy: p.iy };
    if (!this.drag) {
      // Hover cursor feedback.
      const tol = HANDLE_PX / this.scale;
      let cur = "grab";
      const handles = this.handleList();
      handles.sort((a, b) => b.id.length - a.id.length);
      for (const hpos of handles) {
        if (Math.abs(p.ix - hpos.x) <= tol && Math.abs(p.iy - hpos.y) <= tol) {
          cur = hpos.cx;
          break;
        }
      }
      if (cur === "grab") {
        const f = this.frame;
        if (p.ix >= f.x && p.ix <= f.x + f.w && p.iy >= f.y && p.iy <= f.y + f.h) cur = "move";
      }
      this.ui.vp.style.cursor = cur;
      return;
    }
    if (this.drag.mode === "pan") {
      this.ui.vp.style.cursor = "grabbing";
      this.offX = this.drag.startOffX + (p.sx - this.drag.startSx);
      this.offY = this.drag.startOffY + (p.sy - this.drag.startSy);
      return;
    }
    this.applyDrag(p.ix, p.iy, e.shiftKey);
    // One-shot cap flash: a manual resize (edge/corner) growing into the
    // MP limit fires a single short flash; sitting at the cap never repeats.
    // The hard-clamped frame can sit up to a snap step under the nominal cap,
    // so "at the cap" means touching the cap wall, not an area threshold.
    const fr = this.frame;
    const area = fr.w * fr.h;
    const cap = this.mpOn ? this.mp * 1e6 : Infinity;
    const maxW = this.maxDimFor(fr.h);
    const maxH = this.maxDimForW(fr.w);
    const walled = this.mpOn && (area >= cap * 0.98 ||
      fr.w >= maxW - Math.max(SNAP, maxW * 0.02) ||
      fr.h >= maxH - Math.max(SNAP, maxH * 0.02));
    const resizing = this.drag.mode !== "pan" && this.drag.mode !== "move";
    if (walled && !this._wasAtCap && resizing && area > this._prevArea) {
      this.capFlashUntil = performance.now() + 350;
    }
    this._wasAtCap = walled;
    this._prevArea = area;
    this.syncToolbar();
  },

  onUp() {
    if (!this.drag) return;
    // Panning only moves the viewport: no auto-zoom refit afterwards, so a
    // hand-set zoom survives view drags. Frame edits still refit.
    const wasPan = this.drag.mode === "pan";
    this.drag = null;
    if (wasPan) return;
    // Hard MP cap: corner/edge drags can never exceed the limit, so there
    // is nothing to spring back — just commit the frame.
    this.commit();
  },

  applyDrag(ix, iy, shift) {
    const d = this.drag;
    if (!d) return;
    const f0 = d.f0;
    const tol = EDGE_SNAP_PX / this.scale;
    const f = this.frame;

    if (d.mode === "move") {
      let nx = f0.x + (ix - d.startIx);
      let ny = f0.y + (iy - d.startIy);
      // Snap each frame edge to the corresponding image edge — from both the
      // inside (pad -> 0) and the outside (frame edge meets image edge).
      nx = snapTo(nx, 0, tol);
      nx = snapTo(nx, this.W - f0.w, tol);
      ny = snapTo(ny, 0, tol);
      ny = snapTo(ny, this.H - f0.h, tol);
      // Snap each frame edge to the image center lines as well, so the
      // sides of an inner crop box also align to the middle of the picture.
      nx = snapTo(nx, this.W / 2, tol);
      nx = snapTo(nx, this.W / 2 - f0.w, tol);
      ny = snapTo(ny, this.H / 2, tol);
      ny = snapTo(ny, this.H / 2 - f0.h, tol);
      // Also snap the frame CENTER to the image center, so the mask can be
      // centered on the picture with one drag.
      if (Math.abs(nx + f0.w / 2 - this.W / 2) <= tol) {
        nx = (this.W - f0.w) / 2;
      }
      if (Math.abs(ny + f0.h / 2 - this.H / 2) <= tol) {
        ny = (this.H - f0.h) / 2;
      }
      // Snap the frame CENTERLINES to the image edges as well, so the mask
      // center can be parked exactly on the picture border with one drag.
      if (Math.abs(nx + f0.w / 2) <= tol) {
        nx = -f0.w / 2;
      }
      if (Math.abs(nx + f0.w / 2 - this.W) <= tol) {
        nx = this.W - f0.w / 2;
      }
      if (Math.abs(ny + f0.h / 2) <= tol) {
        ny = -f0.h / 2;
      }
      if (Math.abs(ny + f0.h / 2 - this.H) <= tol) {
        ny = this.H - f0.h / 2;
      }
      f.x = nx;
      f.y = ny;
      this.boundsClamp(f);
      return;
    }

    const mode = d.mode;
    const isCorner = mode.length === 2;
    if (isCorner) {
      // PROPORTIONAL by default; hold Shift to resize freely (this used to be
      // the other way around).
      if (shift) this.dragCornerFree(mode, ix, iy, tol);
      else this.dragCornerProportional(mode, ix, iy);
    } else {
      this.dragEdge(mode, ix, iy, tol);
    }
  },


  dragEdge(mode, ix, iy, tol) {
    const f0 = this.drag.f0;
    const f = this.frame;
    const minS = ceilSnap(MIN_DIM);
    if (mode === "e") {
      // Snap on the RAW pointer distance (zoom-proof): rounding first would
      // shift the test by up to 4 px and miss the edge when zoomed in.
      const raw = ix - f0.x;
      let w = roundSnap(raw);
      if (Math.abs(raw - (this.W - f0.x)) <= tol) w = this.W - f0.x; // right -> image right
      else if (Math.abs(raw - (this.W / 2 - f0.x)) <= tol) w = this.W / 2 - f0.x; // right -> center
      else if (Math.abs(raw - -f0.x) <= tol) w = -f0.x; // right -> image left (touch)
      // Right edge stays at least at the image left edge (touch).
      f.w = clamp(w, Math.max(minS, -f0.x), this.maxDimFor(f0.h));
      f.x = f0.x;
      f.y = f0.y;
      f.h = f0.h;
    } else if (mode === "s") {
      const raw = iy - f0.y;
      let h = roundSnap(raw);
      if (Math.abs(raw - (this.H - f0.y)) <= tol) h = this.H - f0.y; // bottom -> image bottom
      else if (Math.abs(raw - (this.H / 2 - f0.y)) <= tol) h = this.H / 2 - f0.y; // bottom -> center
      else if (Math.abs(raw - -f0.y) <= tol) h = -f0.y; // bottom -> image top (touch)
      // Bottom edge stays at least at the image top edge (touch).
      f.h = clamp(h, Math.max(minS, -f0.y), this.maxDimForW(f0.w));
      f.x = f0.x;
      f.y = f0.y;
      f.w = f0.w;
    } else if (mode === "w") {
      const right = f0.x + f0.w;
      const raw = ix;
      let lx = roundSnap(raw);
      if (Math.abs(raw) <= tol) lx = 0; // left -> image left
      else if (Math.abs(raw - this.W / 2) <= tol) lx = this.W / 2; // left -> center
      else if (Math.abs(raw - this.W) <= tol) lx = this.W; // left -> image right (touch)
      // The left edge never passes the image right edge (touch).
      f.x = clamp(lx, right - this.maxDimFor(f0.h), Math.min(right - minS, this.W));
      f.w = right - f.x;
      f.y = f0.y;
      f.h = f0.h;
    } else if (mode === "n") {
      const bottom = f0.y + f0.h;
      const raw = iy;
      let ty = roundSnap(raw);
      if (Math.abs(raw) <= tol) ty = 0; // top -> image top
      else if (Math.abs(raw - this.H / 2) <= tol) ty = this.H / 2; // top -> center
      else if (Math.abs(raw - this.H) <= tol) ty = this.H; // top -> image bottom (touch)
      // The top edge never passes the image bottom edge (touch).
      f.y = clamp(ty, bottom - this.maxDimForW(f0.w), Math.min(bottom - minS, this.H));
      f.h = bottom - f.y;
      f.x = f0.x;
      f.w = f0.w;
    }
    this.boundsClamp(f);
  },

  dragCornerFree(mode, ix, iy, tol) {
    const f0 = this.drag.f0;
    const f = this.frame;
    const minS = ceilSnap(MIN_DIM);
    // Snap the moving corner to the image edges (pad -> 0) and center lines.
    // Recorded (not re-derived later): the snap decision is made on the RAW
    // pointer, zoom-proof, and re-applied exactly after 8-rounding.
    let snapX = null;
    let snapY = null;
    if (Math.abs(ix) <= tol) {
      ix = 0;
      snapX = 0;
    }
    if (Math.abs(ix - this.W) <= tol) {
      ix = this.W;
      snapX = this.W;
    }
    if (Math.abs(ix - this.W / 2) <= tol) {
      ix = this.W / 2;
      snapX = this.W / 2;
    }
    if (Math.abs(iy) <= tol) {
      iy = 0;
      snapY = 0;
    }
    if (Math.abs(iy - this.H) <= tol) {
      iy = this.H;
      snapY = this.H;
    }
    if (Math.abs(iy - this.H / 2) <= tol) {
      iy = this.H / 2;
      snapY = this.H / 2;
    }
    let x, y, w, h;
    if (mode === "se") {
      x = f0.x;
      y = f0.y;
      w = ix - x;
      h = iy - y;
    } else if (mode === "nw") {
      w = f0.x + f0.w - ix;
      h = f0.y + f0.h - iy;
      x = ix;
      y = iy;
    } else if (mode === "ne") {
      x = f0.x;
      w = ix - x;
      h = f0.y + f0.h - iy;
      y = iy;
    } else {
      // sw
      w = f0.x + f0.w - ix;
      h = iy - f0.y;
      x = ix;
      y = f0.y;
    }
    w = roundSnap(w);
    h = roundSnap(h);
    // Touch-or-overlap minimums: crop is allowed, but the frame can never
    // leave the image fully (the fixed corner side stays put, so only the
    // moving side needs a touch guard).
    if (mode === "se") {
      w = Math.max(w, -f0.x);
      h = Math.max(h, -f0.y);
    } else if (mode === "nw") {
      w = Math.max(w, f0.x + f0.w - this.W);
      h = Math.max(h, f0.y + f0.h - this.H);
    } else if (mode === "ne") {
      w = Math.max(w, -f0.x);
      h = Math.max(h, f0.y + f0.h - this.H);
    } else {
      // sw
      w = Math.max(w, f0.x + f0.w - this.W);
      h = Math.max(h, -f0.y);
    }
    // MP cap: clamp each side against the other (final pair fits the cap).
    h = clamp(h, minS, this.maxDimForW(Math.max(minS, w)));
    w = clamp(w, minS, this.maxDimFor(Math.max(minS, h)));
    // Exact meet from the RECORDED pointer snap (zoom-proof): the moving
    // side lands pixel-exactly even on non-8-divisible image sizes.
    // Degenerate sizes skipped; reverted on cap breach (cap wins).
    {
      const pw = w;
      const ph = h;
      if (snapX !== null) {
        let cw;
        if (mode === "se" || mode === "ne") cw = snapX - f0.x;
        else cw = f0.x + f0.w - snapX;
        if (cw >= minS) w = cw;
      }
      if (snapY !== null) {
        let ch;
        if (mode === "se" || mode === "sw") ch = snapY - f0.y;
        else ch = f0.y + f0.h - snapY;
        if (ch >= minS) h = ch;
      }
      if (this.mpOn && w * h > this.mp * 1e6) {
        w = pw;
        h = ph;
      }
    }
    // Re-derive the fixed-corner position from the final sizes.
    if (mode === "nw") {
      x = f0.x + f0.w - w;
      y = f0.y + f0.h - h;
    } else if (mode === "ne") {
      y = f0.y + f0.h - h;
    } else if (mode === "sw") {
      x = f0.x + f0.w - w;
    }
    f.x = x;
    f.y = y;
    f.w = w;
    f.h = h;
    this.boundsClamp(f);
  },

  dragCornerProportional(mode, ix, iy) {
    // Proportional resize from a corner (default): the opposite corner stays
    // fixed and the frame keeps its aspect ratio. Crop is allowed, but the
    // frame and the image must always touch or overlap, and the moving
    // (outer) sides snap to the picture edges.
    const f0 = this.drag.f0;
    const tol = EDGE_SNAP_PX / this.scale;
    const a = f0.w / f0.h;
    const minS = ceilSnap(MIN_DIM);
    let ox, oy;
    if (mode === "se") {
      ox = f0.x;
      oy = f0.y;
    } else if (mode === "nw") {
      ox = f0.x + f0.w;
      oy = f0.y + f0.h;
    } else if (mode === "ne") {
      ox = f0.x;
      oy = f0.y + f0.h;
    } else {
      // sw
      ox = f0.x + f0.w;
      oy = f0.y;
    }
    // Pointer snap, recorded for the exact meet at the end (zoom-proof).
    // Edges force (ratio is re-derived from them); center lines only steer
    // the size drive so the aspect ratio is never broken by a snap.
    let snapX = null;
    let snapY = null;
    if (Math.abs(ix) <= tol) {
      ix = 0;
      snapX = 0;
    }
    if (Math.abs(ix - this.W) <= tol) {
      ix = this.W;
      snapX = this.W;
    }
    ix = snapTo(ix, this.W / 2, tol);
    if (Math.abs(iy) <= tol) {
      iy = 0;
      snapY = 0;
    }
    if (Math.abs(iy - this.H) <= tol) {
      iy = this.H;
      snapY = this.H;
    }
    iy = snapTo(iy, this.H / 2, tol);

    let dw = Math.abs(ix - ox);
    let dh = Math.abs(iy - oy);
    // Drive the size from the dominant axis for a natural feel.
    let w = roundSnap(Math.max(dw, dh * a));
    let h = roundSnap(w / a);
    // Re-snap to keep both dims multiples of 8.
    h = roundSnap(h);
    w = roundSnap(h * a);

    // Touch-or-overlap minimums: crop is allowed, but the frame can never
    // leave the image fully (the fixed corner stays valid, so only the
    // moving side needs a touch guard).
    if (mode === "se") {
      w = Math.max(w, -ox);
      h = Math.max(h, -oy);
    } else if (mode === "nw") {
      w = Math.max(w, ox - this.W);
      h = Math.max(h, oy - this.H);
    } else if (mode === "ne") {
      w = Math.max(w, -ox);
      h = Math.max(h, oy - this.H);
    } else {
      w = Math.max(w, ox - this.W);
      h = Math.max(h, -oy);
    }

    // Minimum size parks the frame: while the pointer asks for less, the
    // frame holds the min size for this ratio (pointer-independent, so it
    // stops dead instead of swimming oversized around the cursor).
    if (w < minS || h < minS) {
      if (a >= 1) { h = minS; w = roundSnap(minS * a); }
      else { w = minS; h = roundSnap(minS / a); }
    }
    // MP cap as ONE uniform fit: scale the pair down together so the frame
    // slides along the limit instead of bouncing side by side (sequential
    // per-side clamps fight the pointer and shrink/jitter at the wall).
    // Also covers 8-rounding overshoot: the hard cap always wins.
    if (this.mpOn && w * h > this.mp * 1e6) {
      const sc = Math.sqrt((this.mp * 1e6) / (w * h));
      w = Math.max(minS, floorSnap(w * sc));
      h = Math.max(minS, floorSnap(h * sc));
    }
    // Minimum size parks the frame here too (see above).
    if (w < minS || h < minS) {
      if (a >= 1) { h = minS; w = roundSnap(minS * a); }
      else { w = minS; h = roundSnap(minS / a); }
    }
    // Exact meet LAST from the recorded pointer snap (zoom-proof): the
    // moving side lands pixel-exactly even on non-8-divisible image sizes.
    // Degenerate sizes skipped; reverted on cap breach (cap wins).
    {
      const pw = w;
      const ph = h;
      if (snapX !== null) {
        let cw;
        if (mode === "se" || mode === "ne") cw = snapX - ox;
        else cw = ox - snapX;
        if (cw >= minS) w = cw;
      }
      if (snapY !== null) {
        let ch;
        if (mode === "se" || mode === "sw") ch = snapY - oy;
        else ch = oy - snapY;
        if (ch >= minS) h = ch;
      }
      if (this.mpOn && w * h > this.mp * 1e6) {
        w = pw;
        h = ph;
      }
    }

    let x, y;
    if (mode === "se") {
      x = ox;
      y = oy;
    } else if (mode === "nw") {
      x = ox - w;
      y = oy - h;
    } else if (mode === "ne") {
      x = ox;
      y = oy - h;
    } else {
      x = ox - w;
      y = oy;
    }
    const f = this.frame;
    f.w = w;
    f.h = h;
    f.x = x;
    f.y = y;
    this.boundsClamp(f);
  },

  // ------------------------------------------------------------ presets

  presetRatio(label) {
    // The target aspect ratio of a preset button ("W:H").
    const [a, c] = String(label).split(":").map(Number);
    return a / c;
  },

  updatePresetHighlight() {
    // Highlight the preset whose ratio matches the CURRENT frame ratio
    // (within a relative tolerance), even when the frame was set by dragging
    // the handles. 8 px snapping means the ratio is never exact.
    const ui = this.ui;
    if (!ui) return;
    const f = this.frame;
    if (!f.w || !f.h) return;
    const cur = f.w / f.h;
    // 8 px snapping can shift the ratio more on small frames, so the match
    // tolerance scales with the frame size (>= 2%).
    const tol = Math.max(0.02, 8.0 / Math.max(f.w, f.h));
    let bestLabel = null;
    let bestErr = Infinity;
    for (const b of ui.pills) {
      const label = b.dataset.pill;
      const ratio = this.presetRatio(label);
      const err = Math.abs(cur - ratio) / ratio;
      if (err < bestErr) {
        bestErr = err;
        bestLabel = label;
      }
    }
    const active = bestErr <= tol ? bestLabel : null;
    ui.pills.forEach((b) => b.classList.toggle("active", b.dataset.pill === active));
  },

  applyPreset(ratio) {
    // Smallest possible frame with the requested ratio that still contains
    // the image: one side of the frame equals the image's width or height,
    // the other side only grows as far as the ratio requires.
    const W = this.W;
    const H = this.H;
    let w0 = Math.max(W, H * ratio);
    let h0 = w0 / ratio;
    if (h0 < H) {
      h0 = H;
      w0 = h0 * ratio;
    }
    // Snap the driving side to 8 px, then derive the other side from the
    // snapped value so the frame ratio stays close to the preset.
    const w = clamp(Math.max(ceilSnap(w0), ceilSnap(MIN_DIM)), ceilSnap(MIN_DIM), MAX_DIM);
    let h = roundSnap(w / ratio);
    if (h < ceilSnap(H)) h = ceilSnap(H);
    h = clamp(h, ceilSnap(MIN_DIM), MAX_DIM);
    // Resize around the CURRENT mask center (not the image center).
    const cx = this.frame.x + this.frame.w / 2;
    const cy = this.frame.y + this.frame.h / 2;
    this.frame = { x: 0, y: 0, w, h };
    const place = () => {
      this.frame.x = Math.round(cx - this.frame.w / 2);
      this.frame.y = Math.round(cy - this.frame.h / 2);
      this.boundsClamp(this.frame);
    };
    place();
    this.clampToMP();
    place();
    this.commit();
  },

  resetFrame() {
    // Back to the ORIGINAL image size: no outpaint padding at all (the mask
    // jumps to exactly the source picture). With the MP limit on, the frame
    // is then clamped to the cap around the image center.
    this.frame = { x: 0, y: 0, w: this.W, h: this.H };
    this.boundsClamp(this.frame);
    this.clampToMP();
    this.commit();
  },

  setManualWH() {
    const ui = this.ui;
    ui.wIn._opmDirty = false;
    ui.hIn._opmDirty = false;
    let w = parseFloat(ui.wIn.value);
    let h = parseFloat(ui.hIn.value);
    // Fields show the active unit: convert mm back to pixels first.
    if (this.unit === "mm") {
      w = Number.isFinite(w) ? (w * this.dpi) / MM_PER_INCH : this.frame.w;
      h = Number.isFinite(h) ? (h * this.dpi) / MM_PER_INCH : this.frame.h;
    }
    if (!Number.isFinite(w)) w = this.frame.w;
    if (!Number.isFinite(h)) h = this.frame.h;
    // Keep the frame position (top-left anchor): only the size changes.
    const f = this.frame;
    f.w = clamp(roundSnap(Math.round(w)), ceilSnap(MIN_DIM), MAX_DIM);
    f.h = clamp(roundSnap(Math.round(h)), ceilSnap(MIN_DIM), MAX_DIM);
    this.clampToMP();
    this.boundsClamp(f);
    this.commit();
  },


  // ------------------------------------------------------------ save

  save() {
    const f = this.frame;
    // Gallery pick/drop persisted for the backend merge: pick is the index
    // of the selected variant inside the kept list (or 0), drop holds every
    // batch index not kept.
    const kept = (this.renders || []).map((r) => r.batchIdx);
    const n = Math.max(
      Number((this.node && this.node._opm_render_n) || 0),
      ...kept.map((v) => v + 1),
      0
    );
    const drop = [];
    for (let i = 0; i < n; i++) if (!kept.includes(i)) drop.push(i);
    const pick =
      this.renderSel >= 0 && this.renderSel < kept.length ? this.renderSel : 0;
    const st = {
      v: 1,
      // Pads may be negative (crop); the frame always touches or overlaps
      // the image.
      l: Math.round(-f.x),
      t: Math.round(-f.y),
      r: Math.round(f.x + f.w - this.W),
      b: Math.round(f.y + f.h - this.H),
      mp_on: this.mpOn,
      mp: this.mp,
      // Display-only settings (the backend ignores these keys).
      unit: this.unit,
      dpi: this.dpi,
      render_pick: pick,
      render_drop: drop,
    };
    this.setState(this.node, st);
    const url = this.drawComposite();
    if (url) {
      this.node._opm_preview = url;
      updateNodePreview(this.node, url, { w: Math.round(f.w), h: Math.round(f.h) });
    }
    if (app.graph && app.graph.change) app.graph.change();
    this.close();
  },

  // ------------------------------------------------------------ render gallery

  loadRenders(node) {
    // Session copy of the sampler output batch (executed event refs):
    // dropped batch indices stay hidden, selection restores the saved pick.
    const refs = (node && node._opm_renders) || [];
    const st = this.getState(node);
    const drop = new Set(st.render_drop || []);
    this.renders = [];
    refs.forEach((ref, i) => {
      if (drop.has(i)) return;
      const url = buildViewURL(ref);
      if (!url) return;
      this.renders.push({ batchIdx: i, url, img: null });
    });
    // Full-size images for the workspace paste-preview (thumbs use the URL
    // directly, the browser scales them).
    this.renders.forEach((r) => {
      loadImageURL(r.url)
        .then((im) => {
          if (this.openFlag) r.img = im;
        })
        .catch(() => {
          /* thumb still shows; preview skips until loaded */
        });
    });
    this.renderSel = this.renders.length
      ? Math.max(0, Math.min(st.render_pick || 0, this.renders.length - 1))
      : -1;
    // Final composite thumb (backend merge result, if any this run).
    this.renderFinal = null;
    this.showFinal = false;
    const mref = node && node._opm_merged;
    const murl = mref ? buildViewURL(mref) : null;
    if (murl) {
      const fin = { url: murl, img: null };
      this.renderFinal = fin;
      loadImageURL(murl)
        .then((im) => {
          if (this.openFlag && this.renderFinal === fin) fin.img = im;
        })
        .catch(() => {
          /* thumb still shows; preview skips until loaded */
        });
    }
    this.renderGallery();
  },

  renderGallery() {
    const ui = this.ui;
    if (!ui || !ui.renderList) return;
    const list = ui.renderList;
    list.innerHTML = "";
    if (!this.renders.length) {
      const d = document.createElement("div");
      d.className = "opm-render-empty";
      d.textContent = "No renders yet - press Render on the node, then open the editor.";
      list.appendChild(d);
      return;
    }
    this.renders.forEach((r, i) => {
      const t = document.createElement("div");
      t.className = "opm-thumb" + (i === this.renderSel ? " active" : "");
      t.tabIndex = 0;
      const im = document.createElement("img");
      im.src = r.url;
      im.alt = `Render option ${i + 1}`;
      const tag = document.createElement("span");
      tag.className = "opm-thumb-tag";
      tag.textContent = `V${i + 1}`;
      const acts = document.createElement("div");
      acts.className = "opm-thumb-actions";
      const ok = document.createElement("button");
      ok.className = "opm-thumb-act opm-thumb-accept";
      ok.textContent = "✓";
      ok.title = "Accept: keep only this one and use it";
      ok.addEventListener("click", (e) => {
        e.stopPropagation();
        this.acceptVariant(i);
      });
      const del = document.createElement("button");
      del.className = "opm-thumb-act opm-thumb-drop";
      del.textContent = "✕";
      del.title = "Delete this option";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.dropVariant(i);
      });
      acts.appendChild(ok);
      acts.appendChild(del);
      t.appendChild(im);
      t.appendChild(tag);
      t.appendChild(acts);
      t.addEventListener("click", () => {
        this.renderSel = i;
        this.showFinal = false;
        this.renderGallery();
      });
      t.addEventListener("dblclick", () => this.acceptVariant(i));
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this.renderSel = i;
          this.showFinal = false;
          this.renderGallery();
        }
      });
      list.appendChild(t);
    });
    // Final composite thumb (backend merge result): previews the finished
    // full canvas on the workspace. No accept/delete: it follows the runs.
    if (this.renderFinal) {
      const t = document.createElement("div");
      t.className = "opm-thumb" + (this.showFinal ? " active" : "");
      t.tabIndex = 0;
      const im = document.createElement("img");
      im.src = this.renderFinal.url;
      im.alt = "Final composite";
      const tag = document.createElement("span");
      tag.className = "opm-thumb-tag final";
      tag.textContent = "Final";
      t.appendChild(im);
      t.appendChild(tag);
      const show = () => {
        this.showFinal = true;
        this.renderGallery();
      };
      t.addEventListener("click", show);
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter") show();
      });
      list.appendChild(t);
    }
  },

  acceptVariant(i) {
    // Green check: delete every other option and use this one. The pick is
    // stored into the workflow on OK; the backend merges it on next run.
    if (!this.renders[i]) return;
    this.renders = [this.renders[i]];
    this.renderSel = 0;
    // The old Final no longer matches the new selection: it rebuilds on
    // the next run.
    this.renderFinal = null;
    this.showFinal = false;
    this.renderGallery();
    showToast("Variant accepted - press OK to save it into the workflow.");
  },

  dropVariant(i) {
    // Red X: delete only this option from the session gallery.
    if (i < 0 || i >= this.renders.length) return;
    this.renders.splice(i, 1);
    if (!this.renders.length) this.renderSel = -1;
    else if (this.renderSel > i) this.renderSel--;
    else if (this.renderSel >= this.renders.length) this.renderSel = this.renders.length - 1;
    this.renderFinal = null;
    this.showFinal = false;
    this.renderGallery();
  },

  drawComposite() {
    // Node preview: original image on the frame-selected canvas, outpaint
    // area in neutral checkerboard, thin frame border, no burned-in label.
    const f = this.frame;
    const c = document.createElement("canvas");
    const sc = Math.min(1, 1024 / Math.max(f.w, f.h), 640 / Math.max(this.W, this.H));
    c.width = Math.max(8, Math.round(f.w * sc));
    c.height = Math.max(8, Math.round(f.h * sc));
    const ctx = c.getContext("2d");
    ctx.fillStyle = getGapPattern(ctx);
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(
      this.img,
      Math.round(-f.x * sc),
      Math.round(-f.y * sc),
      Math.round(this.W * sc),
      Math.round(this.H * sc)
    );
    ctx.strokeStyle = "#4f8cff";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
    try {
      return c.toDataURL("image/jpeg", 0.88);
    } catch (e) {
      return null;
    }
  },
};

// ------------------------------------------------- node preview update

function updateNodePreview(node, dataUrl, dims) {
  if (!dataUrl) return;
  if (isLegacy()) {
    // Nodes 1 (canvas UI): swap node.imgs[0] to the composite.
    const img = new Image();
    img.onload = () => {
      try {
        node.imgs = [img];
        if (typeof node.setSizeForImage === "function") node.setSizeForImage();
        node.setDirtyCanvas(true, false);
      } catch (e) {
        /* ignore */
      }
    };
    img.src = dataUrl;
  } else {
    // Nodes 2 (Vue UI): replace the preview img with the composite.
    setDomPreview(node, dataUrl, dims);
  }
}

function findPreviewImg(cont) {
  let best = null;
  let bestArea = 0;
  cont.querySelectorAll("img").forEach((im) => {
    if (im.classList.contains("opm-tint")) return;
    const r = im.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea && r.width > 8 && r.height > 8) {
      best = im;
      bestArea = area;
    }
  });
  return best;
}

function setDomPreview(node, url, dims) {
  try {
    const cont = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!cont) return;
    const ref = findPreviewImg(cont);
    if (!ref) return;
    if (getComputedStyle(cont).position === "static") cont.style.position = "relative";
    let ov = cont.querySelector("img.opm-tint");
    if (!ov) {
      ov = document.createElement("img");
      ov.className = "opm-tint";
      cont.appendChild(ov);
    }
    ov._opmRef = ref;
    ov.src = url;
    if (dims && dims.w && dims.h) {
      ov._opmDims = dims;
      ov.alt = `Outpaint canvas ${dims.w} x ${dims.h}`;
      ov.title = `Outpaint canvas ${dims.w} x ${dims.h} - click to edit`;
    }
    fitOverlay(ov);
    // Clicking the preview overlay (or the preview image beneath it) opens
    // the editor. pointerdown is stopped first so the click does not start
    // a node drag. Guarded so repeated preview updates don't stack handlers.
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditorSafe(node);
    };
    if (!ov._opmClickWired) {
      ov.addEventListener("pointerdown", (e) => e.stopPropagation());
      ov.addEventListener("click", open);
      ov._opmClickWired = true;
    }
    if (!ref._opmClickWired) {
      ref.style.cursor = "pointer";
      ref.addEventListener("pointerdown", (e) => e.stopPropagation());
      ref.addEventListener("click", open);
      ref._opmClickWired = true;
    }
  } catch (e) {
    /* best-effort preview */
  }
}

function hidePreviewOriginal(ref) {
  // Hide the stale backend preview but keep its layout box: the replacement
  // composite is fitted exactly into that slot (aspect-correct via
  // object-fit: contain).
  try {
    if (!ref._opmHidden) {
      ref.style.visibility = "hidden";
      ref._opmHidden = true;
    }
  } catch (e) {
    /* ignore */
  }
}

function revealPreviewOriginals(cont) {
  // A fresh backend preview (after queue) retires our instant replacement.
  try {
    cont.querySelectorAll("img.opm-tint").forEach((o) => o.remove());
    cont.querySelectorAll("img").forEach((im) => {
      if (im._opmHidden) {
        im.style.visibility = "";
        delete im._opmHidden;
      }
    });
  } catch (e) {
    /* ignore */
  }
}

function fitOverlay(ov) {
  const ref = ov._opmRef;
  const cont = ov.parentElement;
  if (!ref || !cont || !ref.isConnected) return;
  hidePreviewOriginal(ref);
  let x = null;
  let y = null;
  let w = 0;
  let h = 0;
  if (ref.offsetWidth > 0 && ref.offsetHeight > 0) {
    // Offset coordinates inside the node container (not viewport rects), so
    // the replacement stays glued to the preview slot under canvas zoom/pan.
    x = 0;
    y = 0;
    let el = ref;
    while (el && el !== cont) {
      x += el.offsetLeft || 0;
      y += el.offsetTop || 0;
      el = el.offsetParent;
    }
    if (el !== cont) {
      x = null;
    } else {
      w = ref.offsetWidth;
      h = ref.offsetHeight;
    }
  }
  if (x === null) {
    // Fallback for exotic layouts: viewport-rect math, corrected for zoom.
    const cr = cont.getBoundingClientRect();
    const pr = ref.getBoundingClientRect();
    const sx = pr.width / ((ref.offsetWidth || pr.width) || 1);
    x = (pr.left - cr.left) / sx;
    y = (pr.top - cr.top) / sx;
    w = ref.offsetWidth || pr.width;
    h = ref.offsetHeight || pr.height;
  }
  ov.style.left = `${x}px`;
  ov.style.top = `${y}px`;
  ov.style.width = `${w}px`;
  ov.style.height = `${h}px`;
}

// ------------------------------------------------- preview paste button
// Hover "paste from clipboard" icon on the node preview (same UX as the
// FastMask node): pixel-exact clone of the native download hover button,
// first in the native .actions bar (left of download); floating fallback
// when the bar is missing. Click uploads the clipboard image to the input
// folder and selects it on the node at once.

// Fallback copy of the native preview action button classes (h-8 = 32px).
// Used only when the native download button has not rendered yet.
const OPM_NATIVE_BTN_CLS = "flex h-8 min-h-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-base-foreground p-2 text-base-background shadow-interface transition-colors duration-200 hover:bg-base-foreground/90";
// Gap between the paste and download icons (native flex gap + extra margin).
const OPM_PASTE_GAP = 8;

function opmIconPaste() {
  return '<i class="icon-[lucide--clipboard-paste] size-4" aria-hidden="true"></i>';
}

function opmApplyNewImageToNode(node, value) {
  const imgW = (node.widgets || []).find((x) => x && x.name === "image");
  const oldVal = imgW ? imgW.value : undefined;
  const setW = (name, v) => {
    const w = (node.widgets || []).find((x) => x && x.name === name);
    if (!w) return;
    if (name === "image") {
      // Make sure the combo accepts the freshly uploaded file name.
      if (!w.options) w.options = {};
      if (!Array.isArray(w.options.values)) w.options.values = [];
      if (!w.options.values.includes(v)) w.options.values.push(v);
    }
    w.value = v;
    const idx = (node.widgets || []).indexOf(w);
    if (idx >= 0 && node.widgets_values) node.widgets_values[idx] = v;
    if (typeof w.callback === "function") {
      try {
        w.callback.call(w, v);
      } catch (e) {
        /* ignore */
      }
    }
  };
  setW("image", value);
  // Notify the graph layer exactly like the built-in upload flow does, or
  // the dropdown DOM and the queue validation never learn the new value.
  try {
    if (typeof node.onWidgetChanged === "function") {
      node.onWidgetChanged("image", value, oldVal, imgW || null);
    }
  } catch (e) {
    /* ignore */
  }
  // A new image invalidates the cached source ref (else the editor would
  // open the previous picture); the frame itself is kept.
  try {
    node._opm_source = null;
    node._opm_preview = null;
  } catch (e) {
    /* ignore */
  }
  opmShowPastedPreview(node, value);
  try {
    if (app.graph && app.graph.change) app.graph.change();
  } catch (e) {
    /* ignore */
  }
}

function opmShowPastedPreview(node, value) {
  // Point the node preview at the newly pasted file right away (no queue
  // needed) and drop the stale mask composite overlay covering it.
  try {
    const cont = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!cont) return;
    revealPreviewOriginals(cont);
    const preview = findPreviewImg(cont);
    if (preview && preview.tagName === "IMG" && value) {
      const seg = String(value).split("/");
      const fname = seg.pop();
      const sub = seg.join("/");
      preview.src = api.apiURL("/view?" + new URLSearchParams({
        filename: fname,
        subfolder: sub,
        type: "input",
      }));
    }
  } catch (e) {
    /* never break paste over cosmetics */
  }
}

async function opmHandlePastedFiles(node, files) {
  const imgs = Array.from(files || []).filter(
    (f) => f && typeof f.type === "string" && f.type.startsWith("image/")
  );
  if (!imgs.length) return false;
  const f = imgs[0];
  const fd = new FormData();
  fd.append("image", f, f.name || "pasted-image.png");
  fd.append("overwrite", "false");
  fd.append("type", "input");
  try {
    // Upload to the input root with overwrite=false, like the native
    // right-click "Paste Image" flow (server dedupes the file name).
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload failed: " + r.status);
    const j = await r.json();
    const fname = j.name || j.filename;
    if (!fname) throw new Error("upload response missing filename");
    opmApplyNewImageToNode(node, j.subfolder ? j.subfolder + "/" + fname : fname);
  } catch (err) {
    showToast("Paste failed: " + (err && err.message ? err.message : err));
  }
  return true;
}

function installOpmPaste(node) {
  // Route the core right-click "Paste Image" flow through our upload path
  // (it calls node.pasteFile / node.pasteFiles after reading the clipboard).
  try {
    const prevFiles = node.pasteFiles;
    node.pasteFile = function (file) {
      return opmHandlePastedFiles(node, [file]);
    };
    node.pasteFiles = function (files) {
      const imgs = Array.from(files || []).filter(
        (f) => f && typeof f.type === "string" && f.type.startsWith("image/")
      );
      if (imgs.length) return opmHandlePastedFiles(node, imgs);
      return prevFiles ? prevFiles.call(node, files) : false;
    };
    try {
      node.previewMediaType = "image";
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    /* ignore */
  }
}

async function opmPasteFromClipboard(node, btnEl) {
  if (btnEl) btnEl.classList.add("opm-busy");
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
      showToast("Clipboard read is not supported in this browser.");
      return;
    }
    let items = [];
    try {
      items = await navigator.clipboard.read();
    } catch (err) {
      showToast("Clipboard access denied - click the page once and try again.");
      return;
    }
    for (const item of items || []) {
      const imgType = (item.types || []).find((t) => typeof t === "string" && t.indexOf("image/") === 0);
      if (!imgType) continue;
      let blob = null;
      try {
        blob = await item.getType(imgType);
      } catch (e) {
        continue;
      }
      if (!blob) continue;
      const ext = imgType.indexOf("jpeg") !== -1 || imgType.indexOf("jpg") !== -1 ? "jpg"
        : imgType.indexOf("webp") !== -1 ? "webp"
        : imgType.indexOf("gif") !== -1 ? "gif" : "png";
      const file = new File([blob], "pasted-image." + ext, { type: blob.type || imgType });
      if (await opmHandlePastedFiles(node, [file])) return;
    }
    showToast("No image found in the clipboard.");
  } catch (err) {
    showToast("Paste failed: " + (err && err.message ? err.message : err));
  } finally {
    if (btnEl) btnEl.classList.remove("opm-busy");
  }
}

function opmFindNativeActions(box) {
  try {
    const all = box.querySelectorAll(".actions");
    for (const a of all) {
      if (a.querySelector && a.querySelector("button")) return a;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function opmFindNativeDownloadBtn(box) {
  try {
    const els = box.querySelectorAll("button, a");
    for (const b of els) {
      if (!b || b === box._opmPasteBtn) continue;
      if (b.classList && b.classList.contains("opm-preview-paste")) continue;
      const html = (b.innerHTML || "").toLowerCase();
      if (html.indexOf("lucide--download") !== -1) return b;
      const lab = (((b.getAttribute && b.getAttribute("aria-label")) || "") + " " +
        ((b.getAttribute && b.getAttribute("title")) || "")).toLowerCase();
      if (lab.indexOf("download") !== -1) return b;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function opmRaisePreviewActions(box) {
  // Our replacement composite (z-index 5) would cover the hover bar.
  try {
    const all = box.querySelectorAll ? box.querySelectorAll(".actions") : [];
    for (const a of all) {
      if (a.style && a.style.zIndex !== "20") a.style.zIndex = "20";
    }
  } catch (e) {
    /* ignore */
  }
}

function opmPlaceFallbackBtn(box, b, native) {
  // No native .actions bar: park the clone left of the native download
  // button using measured offsets (or the bar's usual corner as fallback).
  try {
    if (native && (native === box || (box.contains && box.contains(native)))) {
      let left = 0;
      let top = 0;
      let n = native;
      while (n && n !== box) {
        left += n.offsetLeft || 0;
        top += n.offsetTop || 0;
        n = n.offsetParent;
      }
      const w = native.offsetWidth || 32;
      b.style.position = "absolute";
      b.style.left = Math.max(0, left - OPM_PASTE_GAP - w) + "px";
      b.style.top = top + "px";
      b.style.width = w + "px";
      b.style.height = (native.offsetHeight || 32) + "px";
      b.style.right = "auto";
      return;
    }
  } catch (e) {
    /* fall through to the parked position */
  }
  try {
    b.style.position = "absolute";
    b.style.left = "auto";
    b.style.top = "8px";
    b.style.right = 8 + 32 + OPM_PASTE_GAP + "px";
    b.style.width = "";
    b.style.height = "";
  } catch (e) {
    /* ignore */
  }
}

function ensurePreviewPasteButton(node) {
  try {
    const cont = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!cont) return;
    const preview = findPreviewImg(cont);
    if (!preview) return;
    const box = preview.parentElement;
    if (!box) return;
    const actions = opmFindNativeActions(box);
    const native = opmFindNativeDownloadBtn(box);
    if (actions) opmRaisePreviewActions(box);
    const btnCls = (native && typeof native.className === "string" && native.className) || OPM_NATIVE_BTN_CLS;
    let b = box._opmPasteBtn;
    if (b && b.isConnected) {
      // Keep the clone in sync: native classes may resolve after us, and the
      // button must stay FIRST in the actions bar (left of download).
      try {
        if (b._opmNativeCls !== btnCls) {
          b._opmNativeCls = btnCls;
          b.className = "opm-preview-paste opm-extra-gap " + btnCls;
        }
        if (actions) {
          b.style.left = "";
          b.style.top = "";
          b.style.width = "";
          b.style.height = "";
          b.style.right = "";
          b.style.position = "";
          if (b.parentElement !== actions) actions.insertBefore(b, actions.firstChild);
          else if (actions.firstChild !== b) actions.insertBefore(b, actions.firstChild);
        } else {
          opmPlaceFallbackBtn(box, b, native);
        }
      } catch (e) {
        /* ignore */
      }
      return;
    }
    const nb = document.createElement("button");
    nb.type = "button";
    nb._opmNativeCls = btnCls;
    nb.innerHTML = opmIconPaste();
    nb.title = "Paste image from clipboard";
    nb.setAttribute("aria-label", "Paste image from clipboard");
    nb.addEventListener("pointerdown", (e) => e.stopPropagation());
    nb.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      opmPasteFromClipboard(node, nb);
    });
    if (actions) {
      nb.className = "opm-preview-paste opm-extra-gap " + btnCls;
      actions.insertBefore(nb, actions.firstChild);
    } else {
      if (getComputedStyle(box).position === "static") box.style.position = "relative";
      box.classList.add("opm-preview-box");
      nb.className = "opm-preview-paste opm-fallback " + btnCls;
      opmPlaceFallbackBtn(box, nb, native);
      box.appendChild(nb);
    }
    box._opmPasteBtn = nb;
  } catch (e) {
    /* never break the app over cosmetics */
  }
}

// Cheap self-heal tick: keeps per-node UI (hidden state widget, button
// placement, preview click-to-open, tint overlay) correct even after
// frontend re-renders, paste/duplicate, or late extension loading.
setInterval(() => {
  if (document.hidden) return;
  try {
    const legacy = isLegacy();
    const nodes = (app.graph && app.graph._nodes) || [];
    for (const n of nodes) {
      if (!n || (n.comfyClass !== NODE_NAME && n.type !== NODE_NAME)) continue;
      if (!n._opm_setup) setupNode(n);
      else {
        hideStateWidget(n);
        assertOpenWidgetLast(n);
      }
      if (!legacy) {
        wireNodePreviewClick(n);
        keepOpenButtonBelowPreview(n);
        ensurePreviewPasteButton(n);
      }
    }
  } catch (e) {
    /* ignore */
  }
  if (!document.querySelector("img.opm-tint")) return;
  document.querySelectorAll("img.opm-tint").forEach((ov) => {
    const cont = ov.parentElement;
    if (!cont || !cont.isConnected) {
      ov.remove();
      return;
    }
    const ref = ov._opmRef;
    if (!ref || !ref.isConnected) {
      const cur = findPreviewImg(cont);
      if (cur) {
        ov._opmRef = cur;
        fitOverlay(ov);
      } else {
        ov.remove();
      }
      return;
    }
    fitOverlay(ov);
  });
}, 2000);


// ------------------------------------------------- extension registration

function openEditorSafe(node) {
  Editor.open(node).catch((err) => {
    console.error("[OutpaintMask] editor open failed:", err);
    showToast("Editor failed to open (see console).");
  });
}

function queueRender(node) {
  // Render button: queues the current workflow (same as Ctrl+Enter). The
  // sampler output flows into the rendered input, the merge runs, and the
  // variants land in the editor gallery.
  try {
    if (node && typeof node.setDirtyCanvas === "function") {
      try {
        node.setDirtyCanvas(true, true);
      } catch (e) {
        /* ignore */
      }
    }
    if (app && typeof app.queuePrompt === "function") {
      const r = app.queuePrompt(0);
      try {
        if (Editor.openFlag) Editor.showProgressBusy();
      } catch (e) {
        /* strip is best-effort */
      }
      if (r && typeof r.catch === "function") {
        r.catch((err) => {
          console.error("[OutpaintMask] queue failed:", err);
          showToast("Render queue failed (see console).");
        });
      } else {
        showToast("Render queued - variants appear in the gallery.");
      }
      return;
    }
    showToast("Auto-queue unavailable here - press Ctrl+Enter to render.");
  } catch (e) {
    console.error("[OutpaintMask] queue failed:", e);
    showToast("Render queue failed (see console).");
  }
}

function makeOpenButtonEl(node) {
  // Fixed-height wrapper so the button never grows vertically.
  // Inject CSS here (not only on first editor open): otherwise the node
  // button renders unstyled until the user clicks it once.
  injectCss();
  const wrap = document.createElement("div");
  wrap.className = "opm-open-wrap";
  const b = document.createElement("button");
  b.className = "opm-open-btn";
  b.textContent = `Outpaint Editor v${VERSION}`;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEditorSafe(node);
  });
  wrap.appendChild(b);
  node._opm_openBtn = wrap;
  return wrap;
}

function hideStateWidget(node) {
  // The outpaint_state widget carries the frame JSON to the backend but must
  // not take any node space. hidden/options.hidden is what the frontend
  // reads; computeSize collapses canvas layout; the DOM-input hide covers
  // STRING widgets that position an <input> by canvas coords. The value
  // keeps flowing to the backend (visibility is not serialization).
  try {
    const w = (node.widgets || []).find((x) => x && x.name === "outpaint_state");
    if (!w || w._opm_hidden) return;
    w._opm_hidden = true;
    w.hidden = true;
    w.options = w.options || {};
    w.options.hidden = true;
    const origSize = w.computeSize;
    w.computeSize = function (...args) {
      try {
        if (this.hidden || (this.options && this.options.hidden)) return [0, -4];
      } catch (e) {
        /* ignore */
      }
      return typeof origSize === "function" ? origSize.apply(this, args) : [0, 0];
    };
    for (const key of ["element", "inputEl"]) {
      const el = w[key];
      if (el && el.style) el.style.display = "none";
    }
  } catch (e) {
    /* ignore */
  }
}

function assertOpenWidgetLast(node) {
  // Helper widgets must stay last: workflow save is index-based, so a helper
  // before real widgets would shift every value on the next open.
  try {
    const arr = node.widgets || [];
    const ix = arr.findIndex((w) => w && w.name === "opm_open");
    if (ix >= 0 && ix !== arr.length - 1) {
      const [wb] = arr.splice(ix, 1);
      arr.push(wb);
    }
  } catch (e) {
    /* ignore */
  }
}

function wireNodePreviewClick(node) {
  // Clicking the node preview opens the editor, even before the first OK
  // (when no tint overlay exists yet). Two layers: the image itself plus the
  // whole preview box (survives img swaps and pointer-events quirks).
  // Click-only, buttons excluded: node dragging by the image keeps working.
  try {
    const cont = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!cont) return;
    const ref = findPreviewImg(cont);
    const box = ref ? ref.parentElement : null;
    if (box && box !== cont && !box._opmBoxClickWired) {
      box.style.cursor = "pointer";
      box.title = "Click to open Outpaint editor";
      box.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button, a, input, select, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        openEditorSafe(node);
      });
      box._opmBoxClickWired = true;
    }
    if (!ref || ref._opmClickWired) return;
    ref.style.cursor = "pointer";
    ref.title = "Click to open Outpaint editor";
    ref.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("button, a")) return;
      e.preventDefault();
      e.stopPropagation();
      openEditorSafe(node);
    });
    ref._opmClickWired = true;
  } catch (e) {
    /* ignore */
  }
}

function keepOpenButtonBelowPreview(node) {
  // Keep the open button BELOW the preview image (same UX as the FastMask
  // node). Only the DOM order changes: the widget stays last in
  // node.widgets, so workflow save/restore is untouched. Re-applied through
  // a MutationObserver because the frontend re-renders the node DOM (image
  // load, resize, workflow load) and would otherwise put the button back
  // above the preview.
  try {
    if (!node || isLegacy()) return; // Nodes 1: canvas preview, widget flow is fine
    const wOpen = (node.widgets || []).find((w) => w && w.name === "opm_open");
    if (!wOpen || !wOpen.element || !wOpen.element.isConnected) return;
    const nodeEl = wOpen.element.closest("[data-node-id]") || document.querySelector(`[data-node-id="${node.id}"]`);
    if (!nodeEl) return;
    const doMove = () => {
      try {
        const w2 = (node.widgets || []).find((w) => w && w.name === "opm_open");
        if (!w2 || !w2.element || !w2.element.isConnected) return false;
        const wrap = w2.element.closest(".comfy-widget") || w2.element.parentElement || w2.element;
        const nEl = w2.element.closest("[data-node-id]") || document.querySelector(`[data-node-id="${node.id}"]`);
        if (!nEl) return false;
        const pv = findPreviewImg(nEl);
        if (!pv) return false; // preview not rendered yet
        const pvBox = pv.closest(".image-preview") || pv.closest(".comfy-widget") || pv.parentElement;
        if (!wrap || !pvBox || wrap === pvBox || pvBox.contains(wrap)) return true;
        if (wrap.compareDocumentPosition(pvBox) & Node.DOCUMENT_POSITION_FOLLOWING) {
          pvBox.after(wrap);
        }
        try {
          wrap.style.setProperty("margin-top", "8px", "important");
          wrap.style.setProperty("margin-bottom", "4px", "important");
          wrap.style.setProperty("width", "100%", "important");
        } catch (e) { /* ignore */ }
        return true;
      } catch (e) { return false; }
    };
    // Keep the button below the preview across frontend re-renders.
    if (!node._opmBelowObs && typeof MutationObserver === "function") {
      try {
        let scheduled = false;
        const mo = new MutationObserver(() => {
          if (scheduled) return;
          scheduled = true;
          setTimeout(() => { scheduled = false; doMove(); }, 50);
        });
        mo.observe(nodeEl, { childList: true, subtree: true });
        node._opmBelowObs = mo;
      } catch (e) { /* ignore */ }
    }
    doMove();
  } catch (e) { /* never break the node over button order */ }
}

function setupNode(node) {
  if (!node) return;
  // Style the node button immediately: buildDom() (the only previous
  // injectCss caller) runs only on first editor open, so without this the
  // open button looks unstyled until the first click.
  injectCss();
  hideStateWidget(node);
  if (node._opm_setup) {
    assertOpenWidgetLast(node);
    return;
  }
  node._opm_setup = true;
  try {
    let wb = (node.widgets || []).find((w) => w && w.name === "opm_open");
    if (!wb && typeof node.addDOMWidget === "function") {
      const el = makeOpenButtonEl(node);
      wb =
        node.addDOMWidget("opm_open", "div", el, {
          getValue() {
            return null;
          },
          setValue() {},
          serialize: false,
          computeSize() {
            return [-1, 36];
          },
        }) || (node.widgets || []).find((w) => w && w.name === "opm_open");
    }
    // The save/restore loops key on widget.serialize (not options): set it
    // directly, or the helper leaks a null into every saved workflow.
    if (wb) wb.serialize = false;
    assertOpenWidgetLast(node);
    // Right-click "Paste Image" through our upload path (also refreshes the
    // preview instantly and drops the stale mask composite).
    installOpmPaste(node);
    // Right-click menu entry.
    const origMenu = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function (canvas, menu) {
      const r = origMenu ? origMenu.apply(this, arguments) : undefined;
      menu.push({
        content: "Open Outpaint Editor",
        callback: () => openEditorSafe(node),
      });
      return r;
    };
  } catch (e) {
    console.error("[OutpaintMask] node setup failed:", e);
  }
}

app.registerExtension({
  name: "Comfy.OutpaintMask",
  nodeCreated(node) {
    if (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME) return;
    setupNode(node);
  },
  async setup() {
    // Handle nodes that already exist when the extension loads.
    try {
      const nodes = (app.graph && app.graph._nodes) || [];
      nodes.forEach((n) => {
        if (n.comfyClass === NODE_NAME || n.type === NODE_NAME) setupNode(n);
      });
    } catch (e) {
      /* ignore */
    }
  },
});

// Cache the source image ref + state pushed by the Python node on execution,
// and keep the state widget in sync (so the preview and the widget agree).
api.addEventListener("executed", ({ detail }) => {
  try {
    const nid = detail && detail.node;
    if (nid == null || !app.graph) return;
    const node = app.graph.getNodeById(nid);
    if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
    const out = detail.output || {};
    if (Array.isArray(out.source) && out.source[0]) node._opm_source = out.source[0];
    // Sampler output batch for the editor render gallery (+ batch size, so
    // the gallery can compute the drop list). A run while the editor is open
    // refreshes the gallery live.
    if (Array.isArray(out.renders)) node._opm_renders = out.renders;
    // NOTE: the core merges ui dicts by iterating every value, so scalars
    // arrive wrapped in single-item lists - unwrap them (never index blindly).
    const rn = Array.isArray(out.render_n) ? out.render_n[0] : out.render_n;
    if (typeof rn === "number") node._opm_render_n = rn;
    // Final composite (backend merge result) for the gallery "Final" thumb.
    const mlist = Array.isArray(out.merged_ref)
      ? out.merged_ref
      : out.merged_ref
        ? [out.merged_ref]
        : [];
    node._opm_merged = mlist.find((r) => r && r.filename) || null;
    if (Editor.openFlag && Editor.node === node) {
      try {
        Editor.loadRenders(node);
      } catch (e) {
        /* gallery refresh is best-effort */
      }
    }
    // A fresh backend preview retires our instant replacement overlay (the
    // backend image carries the new size label).
    try {
      const cont = document.querySelector(`[data-node-id="${nid}"]`);
      if (cont) revealPreviewOriginals(cont);
    } catch (e) {
      /* ignore */
    }
    // The state arrives as a single-item list (the core splits ui strings
    // per character when merging, and it may also arrive as a plain string
    // or a character list) - normalize all shapes back to a string.
    let stateRaw = out.state;
    if (Array.isArray(stateRaw)) stateRaw = stateRaw.join("");
    if (typeof stateRaw === "string") {
      node._opm_state = stateRaw;
      const w = (node.widgets || []).find((x) => x.name === "outpaint_state");
      if (w) w.value = stateRaw;
    }
    // Our own run finished: the gallery just refreshed above, drop the strip.
    try {
      if (Editor.openFlag && Editor.node === node) Editor.hideProgress();
    } catch (e) {
      /* ignore */
    }
  } catch (e) {
    /* ignore */
  }
});

// Queue progress strip: while the editor is open, sampler step events fill
// the thin bar under the topbar; an idle queue (or editor close) hides it.
// All best-effort: event shapes vary across frontend versions.
try {
  api.addEventListener("progress", ({ detail }) => {
    try {
      if (!Editor.openFlag) return;
      const v = detail && detail.value;
      const m = detail && detail.max;
      if (typeof v === "number" && typeof m === "number" && m > 0) {
        Editor.setProgress(v, m);
      } else {
        Editor.showProgressBusy();
      }
    } catch (e) {
      /* ignore */
    }
  });
  api.addEventListener("executing", ({ detail }) => {
    try {
      if (!Editor.openFlag) return;
      const idle = !detail || (!detail.node && !detail.prompt_id);
      if (idle) Editor.hideProgress();
      else Editor.showProgressBusy();
    } catch (e) {
      /* ignore */
    }
  });
} catch (e) {
  /* progress strip stays hidden on old frontends */
}

console.log(`[OutpaintMask] frontend extension v${VERSION} loaded`);
