// Run with node tests/test_alignment.cjs. No browser or npm packages required.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const text = fs.readFileSync(path.join(__dirname, "../web/js/outpaint_ui.js"), "utf8");
const boundary = text.indexOf("// ------------------------------------------------- node preview update");
assert.ok(boundary > 0);
const source = text.slice(0, boundary).replace(/^import .*;\r?\n/gm, "");
const context = vm.createContext({app: {graph: {change() {}}}, console});
vm.runInContext(source + "\nglobalThis.editor = Editor;", context);
const editor = context.editor;
Object.assign(editor, {W: 1344, H: 576, node: {}, mpOn: true, mp: 2, unit: "px", dpi: 300});
editor.close = () => {};
let saved;
let preview;
editor.setState = (node, state) => { saved = state; };
context.updateNodePreview = (node, url, dims) => { preview = dims; };
editor.drawComposite = () => "test-preview";

for (const frame of [
  {x: 0, y: 0, w: 1032, h: 576},
  {x: 24, y: -8, w: 1032, h: 584},
  {x: 0, y: 0, w: 1040, h: 576},
]) {
  editor.frame = {...frame};
  editor.save();
  const width = editor.W + saved.l + saved.r;
  const height = editor.H + saved.t + saved.b;
  assert.equal(width, 1040);
  assert.equal(width % 16, 0);
  assert.equal(height % 16, 0);
  assert.equal(preview.w, width);
  assert.equal(preview.h, height);
  assert.ok(editor.frame.x <= frame.x && editor.frame.x + width >= frame.x + frame.w);
  assert.ok(editor.frame.y <= frame.y && editor.frame.y + height >= frame.y + frame.h);
  const first = JSON.stringify(saved);
  editor.save();
  assert.equal(JSON.stringify(saved), first);
  console.log("PASS save/preview/idempotence:", JSON.stringify(frame), "->", width, height);
}
assert.ok(text.includes('step="${SNAP}"'));
assert.ok(text.includes('mmStep : String(SNAP)'));
console.log("PASS dimension spinners share the frame grid.");
