// A headless editor plus helpers that speak like a person with a mouse.
import { Editor } from "../../core/editor.js";
import { emptyScene } from "../../core/model.js";
import { toSvg } from "../../adapters/svg/svg.js";
import { rasterize } from "./raster.js";

// 8×4 PNG: left half red, right half blue (test/fixtures/tiny.png).
export const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFUlEQVR4nGP4b2AARwYJ/+GIgXoSABarLuG35VBkAAAAAElFTkSuQmCC";

export const THEME = { fg: "#e6e6e6", bg: "#0b0f10", accent: "#5eead4", dim: "#6b7280" };

export function setup({ scene = emptyScene(), w = 900, h = 600 } = {}) {
  let now = 1000;
  const ops = [];
  const ed = new Editor({ scene, onOp: op => ops.push(op), clock: () => now });
  ed.setSize(w, h);
  ed.view = { x: 0, y: 0, scale: 1 };
  const api = {
    ed, ops,
    advance(ms) { now += ms; },
    // A press-move-release, in screen px, with intermediate moves.
    drag(from, to, m = {}, steps = 8) {
      ed.pointerDown({ x: from[0], y: from[1] }, { button: "left", clickCount: 1, ...m });
      for (let i = 1; i <= steps; i++) ed.pointerMove({ x: from[0] + (to[0] - from[0]) * i / steps, y: from[1] + (to[1] - from[1]) * i / steps }, m);
      ed.pointerUp({ x: to[0], y: to[1] }, m);
    },
    click(at, m = {}) { ed.pointerDown({ x: at[0], y: at[1] }, { button: "left", clickCount: 1, ...m }); ed.pointerUp({ x: at[0], y: at[1] }, m); },
    dblclick(at, m = {}) { ed.pointerDown({ x: at[0], y: at[1] }, { button: "left", clickCount: 2, ...m }); ed.pointerUp({ x: at[0], y: at[1] }, m); },
    key(k, m = {}) { return ed.key(k, m); },
    type(text) { ed.setText(text); ed.commitText(); },
    live: () => ed.doc.visible(),
    byType: t => ed.doc.visible().filter(e => e.type === t),
    async shot(name) {
      const svg = toSvg(ed.displayList(THEME), { width: w, height: h, background: THEME.bg, files: ed.doc.files });
      await rasterize(svg, `${import.meta.dir}/../out/${name}.png`, { width: w, height: h });
      return svg;
    },
  };
  return api;
}
