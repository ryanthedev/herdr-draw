// Export: the drawing cropped to what is painted, ready for any painter at any pixel ratio.
// Pure: it builds its own view, so the editor's scroll, zoom, selection and overlays never
// show. exportScene() returns toSvg's arguments: `const s = exportScene(...); toSvg(s.items, s)`.
// PNG is the adapters' job (rasterize that SVG): the core has no pixels.

import { paintScene } from "./render.js";

// What a shared picture usually looks like: Excalidraw's white page and dark ink.
export const LIGHT = { fg: "#1e1e1e", bg: "#ffffff", accent: "#6965db", dim: "#868e96" };

const finite = v => Number.isFinite(v);

// The box around every painted item at scale 1 (scene units): path points (curve controls
// too), text boxes by estimate, images by their rotated corners. Null when nothing paints.
export function paintedBox(doc, theme, items = paintScene(doc, { x: 0, y: 0, scale: 1 }, theme)) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (!finite(x) || !finite(y)) return; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const it of items) {
    if (it.t === "path") {
      const pad = it.fill ? 0 : (it.width ?? 1) / 2;
      for (const c of it.cmds) for (let i = 1; i + 1 < c.length; i += 2) { add(c[i] - pad, c[i + 1] - pad); add(c[i] + pad, c[i + 1] + pad); }
    } else if (it.t === "text") {
      if (it.box) { add(it.box.x, it.box.y); add(it.box.x + it.box.w, it.box.y + it.box.h); continue; }
      const lines = String(it.text ?? "").split("\n"), size = it.size ?? 16;
      add(it.x, it.y); add(it.x + Math.max(...lines.map(l => l.length)) * size * 0.6, it.y + lines.length * size * (it.lineHeight ?? 1.25));
    } else if (it.t === "image") {
      const a = it.angle || 0, c = Math.cos(a), s = Math.sin(a);
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const px = dx * it.w / 2, py = dy * it.h / 2;
        add(it.cx + px * c - py * s, it.cy + px * s + py * c);
      }
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// { scale: pixels per unit (2 for a crisp PNG), padding: units around the drawing,
//   maxPixels: cap on the longest side, background: page color (theme.bg if omitted) }
// → { items, width, height, scale, background, files }: width/height in drawing units.
export function exportScene(doc, theme = LIGHT, { scale = 1, padding = 32, maxPixels = 8192, background = theme.bg } = {}) {
  const box = paintedBox(doc, theme) ?? { x: 0, y: 0, w: 0, h: 0 };
  const view = { x: padding - box.x, y: padding - box.y, scale: 1 };
  const width = Math.max(1, Math.ceil(box.w + padding * 2)), height = Math.max(1, Math.ceil(box.h + padding * 2));   // whole units: clean pixels
  return { items: paintScene(doc, view, theme), width, height, scale: Math.min(scale, maxPixels / Math.max(width, height)), background, files: doc.files };
}

// The board's own page (appState.viewBackgroundColor, white if unset), with ink that reads on it:
// what the drawing looks like in excalidraw.com, whatever theme the pane happens to use.
export const DARK = { fg: "#e9ecef", bg: "#121212", accent: "#a8a5ff", dim: "#868e96" };
export function boardTheme(appState) {
  const bg = /^#[0-9a-f]{6}$/i.test(appState?.viewBackgroundColor ?? "") ? appState.viewBackgroundColor : "#ffffff";
  const [r, g, b] = [1, 3, 5].map(i => parseInt(bg.slice(i, i + 2), 16) / 255);
  return { ...(0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? DARK : LIGHT), bg };
}
