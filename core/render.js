// Board → display list: what to paint, in screen coordinates, in order.
// Adapters (Herdr, SVG, a browser canvas) only paint these items:
//   { t: "path", cmds, stroke, width, dash?, opacity? }   cmds: ["M",x,y] ["L",x,y] ["Q",x,y,cx,cy]
//   { t: "path", cmds, fill, opacity? }                    (closed polygons)
//   { t: "text", x, y, text, size, color, align, box?, lineHeight, opacity? }
//   { t: "image", fileId, mimeType, x, y, w, h, angle, cx, cy, opacity? }   pixels: doc.files[fileId]
// Colors arrive as #rrggbb or #rrggbbaa; the theme decides what "default ink" is.

import { DEFAULT_STROKE, isShape, isLinear, isLabel } from "./model.js";
import { bbox, resolvedPoints, toWorld, angleOf, centerOf, alongPath } from "./geometry.js";
import { animState } from "./anim.js";
import { labelLines } from "./text.js";
import { cornerRadius, roundPolygon, fillLines, arrowheadCmds, fontClass } from "./style.js";

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

const INK = new Set([DEFAULT_STROKE, "#000000", "#000", "black"]);
export function ink(c, theme) {
  if (!c || c === "transparent") return null;
  return INK.has(c) ? theme.fg : c;
}
export function withAlpha(c, a) {
  if (!c || a >= 1) return c;
  const base = c.length === 9 ? c.slice(0, 7) : c.length === 4 ? "#" + [...c.slice(1)].map(x => x + x).join("") : c;
  const prev = c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1;
  return base + Math.round(Math.max(0, Math.min(1, a * prev)) * 255).toString(16).padStart(2, "0");
}

// Outline of a shape as points (scene coords), rotation included.
export function outlinePoints(el) {
  const pts = localOutline(el);
  return angleOf(el) ? pts.map(([x, y]) => { const w = toWorld(el, { x, y }); return [w.x, w.y]; }) : pts;
}
function localOutline(el) {
  const b = bbox(el);
  if (el.type === "rectangle" || el.type === "frame") {
    const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    return roundPolygon(cs, el.type === "rectangle" ? cornerRadius(el, Math.min(b.w, b.h)) : 0);
  }
  if (el.type === "diamond") {
    const cs = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
    return roundPolygon(cs, cornerRadius(el, Math.min(b.w, b.h)) * 0.6);
  }
  const n = 40, cx = b.x + b.w / 2, cy = b.y + b.h / 2, out = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * b.w / 2, cy + Math.sin(a) * b.h / 2]); }
  return out;
}

// The first `f` (0..1) of a polyline by length: the "draw on" animation.
export function trim(pts, f) {
  if (f >= 1 || pts.length < 2) return pts;
  if (f <= 0) return [pts[0]];
  let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * f; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (seg >= left) { const k = seg ? left / seg : 0; out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]); return out; }
    out.push(pts[i]); left -= seg;
  }
  return out;
}

// Two slightly bowed passes per segment: the hand-drawn look. Deterministic per seed.
function sketch(cmds, pts, r, rough, closed) {
  if (pts.length < 2) return;
  if (rough <= 0) { cmds.push(["M", ...pts[0]]); for (let i = 1; i < pts.length; i++) cmds.push(["L", ...pts[i]]); return; }
  const j = () => (r() - 0.5) * 2 * rough;
  const curvy = pts.length > 8;   // ellipses and the like: jitter the whole loop instead of each edge
  for (let pass = 0; pass < 2; pass++) {
    if (curvy) {
      cmds.push(["M", pts[0][0] + j(), pts[0][1] + j()]);
      for (let i = 1; i < pts.length; i++) cmds.push(["L", pts[i][0] + j() * 0.5, pts[i][1] + j() * 0.5]);
      if (closed) cmds.push(["L", pts[1][0] + j(), pts[1][1] + j()]);
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], z = pts[i], dx = z[0] - a[0], dy = z[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const bow = (r() - 0.5) * Math.min(len * 0.04, 6) * rough, k = 0.45 + r() * 0.1;
      cmds.push(["M", a[0] + j(), a[1] + j()], ["Q", z[0] + j(), z[1] + j(), a[0] + dx * k - (dy / len) * bow, a[1] + dy * k + (dx / len) * bow]);
    }
  }
}

function smooth(cmds, pts) {
  cmds.push(["M", ...pts[0]]);
  for (let i = 1; i < pts.length; i++) cmds.push(["Q", (pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2, pts[i - 1][0], pts[i - 1][1]]);
  cmds.push(["L", ...pts[pts.length - 1]]);
}


export const project = view => (x, y) => [(x + view.x) * view.scale, (y + view.y) * view.scale];

// Paint one element into `out`. `P` maps scene → screen.
export function paintElement(doc, el, P, view, theme, out, opts = {}) {
  const a = opts.time == null ? null : animState(el, opts.time);
  if (a && a.opacity <= 0) return;
  const layer = doc.layer(el.customData?.layer);
  const opacity = (el.opacity / 100) * ((layer?.opacity ?? 100) / 100) * (a ? a.opacity : 1);
  const progress = a ? a.progress : 1;
  // Animation offsets and scale apply about the element's center.
  let Q = P;
  if (a && (a.dx || a.dy || a.scale !== 1)) {
    const b = bbox(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    Q = (x, y) => P(cx + (x - cx) * a.scale + a.dx, cy + (y - cy) * a.scale + a.dy);
  }
  const s = view.scale, r = rng(el.seed), rough = (el.roughness ?? 1) * Math.min(1.5, s);
  const stroke = ink(el.strokeColor, theme), fill = ink(el.backgroundColor, theme);
  const width = Math.max(0.5, el.strokeWidth * s), dash = el.strokeStyle === "dashed" ? [8 * s, 6 * s] : el.strokeStyle === "dotted" ? [1.5 * s, 5 * s] : null;

  if (el.type === "text") {
    if (isLabel(el)) {
      const box = doc.get(el.containerId); if (!box) return;
      let b = bbox(box);
      if (isLinear(box)) {   // a line's label sits halfway along its path (elbows included)
        const m = alongPath(resolvedPoints(doc, box)), lw = Math.max(40, String(el.text).length * el.fontSize * 0.6), lh = el.fontSize * 1.4;
        b = { x: m[0] - lw / 2, y: m[1] - lh / 2, w: lw, h: lh };
      }
      const [x0, y0] = Q(b.x, b.y), [x1, y1] = Q(b.x + b.w, b.y + b.h);
      const color = box.backgroundColor !== "transparent" && (!box.fillStyle || box.fillStyle === "solid") && INK.has(el.strokeColor) ? "#1e1e1e" : ink(el.strokeColor, theme);
      const text = isShape(box) ? labelLines(el, box).join("\n") : el.text;   // labels wrap to their shape
      if (isLinear(box)) {   // on a line: a patch of background behind the text, like Excalidraw's gap
        const lines = String(text).split("\n"), s2 = el.fontSize * s, w = Math.max(...lines.map(l => l.length)) * s2 * 0.56 + 10, h = lines.length * s2 * (el.lineHeight ?? 1.25) + 4;
        const [mx, my] = Q(b.x + b.w / 2, b.y + b.h / 2);
        out.push({ t: "path", id: el.id + ":bg", cmds: [["M", mx - w / 2, my - h / 2], ["L", mx + w / 2, my - h / 2], ["L", mx + w / 2, my + h / 2], ["L", mx - w / 2, my + h / 2]], fill: theme.bg, opacity });
      }
      const [cx, cy] = Q(b.x + b.w / 2, b.y + b.h / 2);
      out.push({ t: "text", id: el.id, font: fontClass(el.fontFamily), angle: angleOf(box), cx, cy, x: x0, y: y0, text, size: el.fontSize * s * (a?.scale ?? 1), color, align: "center", box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, lineHeight: el.lineHeight ?? 1.25, opacity, reveal: progress });
    } else {
      const [x, y] = Q(el.x, el.y), c = centerOf(el), [cx, cy] = Q(c.x, c.y);
      out.push({ t: "text", id: el.id, font: fontClass(el.fontFamily), angle: angleOf(el), cx, cy, x, y, text: el.text, size: el.fontSize * s * (a?.scale ?? 1), color: ink(el.strokeColor, theme), align: "left", lineHeight: el.lineHeight ?? 1.25, opacity, reveal: progress });
    }
    return;
  }

  if (el.type === "image") {
    const b = bbox(el), [x0, y0] = Q(b.x, b.y), [x1, y1] = Q(b.x + b.w, b.y + b.h), [cx, cy] = Q(b.x + b.w / 2, b.y + b.h / 2);
    const file = doc.files?.[el.fileId];
    if (file && typeof file.dataURL === "string") {
      out.push({ t: "image", id: el.id, fileId: el.fileId, mimeType: file.mimeType, x: x0, y: y0, w: x1 - x0, h: y1 - y0, angle: angleOf(el), cx, cy, opacity: opacity * progress });
    } else {   // the file hasn't arrived (or was lost): a dashed box where it goes
      const pts = outlinePoints({ ...el, type: "rectangle", roundness: null }).map(p => Q(p[0], p[1]));
      out.push({ t: "path", id: el.id, cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.dim, width: 1, dash: [6, 4], opacity });
    }
    return;
  }

  if (isShape(el)) {
    const pts = outlinePoints(el).map(p => Q(p[0], p[1]));
    if (el.type === "frame") {
      out.push({ t: "path", id: el.id, cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.dim, width: 1, dash: null, opacity });
      out.push({ t: "text", id: el.id + ":name", x: pts[0][0], y: pts[0][1] - 18 * Math.min(1, s), text: el.name || "Frame", size: 12 * Math.min(1, s) + 2, color: theme.dim, align: "left", lineHeight: 1.2, opacity });
      return;
    }
    if (fill && progress >= 1) {
      const poly = pts.slice(0, -1);
      if (!el.fillStyle || el.fillStyle === "solid") out.push({ t: "path", id: el.id, cmds: poly.map((p, i) => [i ? "L" : "M", ...p]), fill, opacity });
      else {   // hachure / cross-hatch / zigzag: lines in the fill color, slightly hand-drawn
        const cmds = [], jj = () => (r() - 0.5) * rough;
        for (const [a, b] of fillLines(el.fillStyle, poly, width)) cmds.push(["M", a[0] + jj(), a[1] + jj()], ["L", b[0] + jj(), b[1] + jj()]);
        if (cmds.length) out.push({ t: "path", id: el.id, cmds, stroke: fill, width: Math.max(0.5, width / 2), dash: null, opacity });
      }
    }
    if (stroke) { const cmds = []; sketch(cmds, trim(pts, progress), r, rough, progress >= 1); out.push({ t: "path", id: el.id, cmds, stroke, width, dash, opacity }); }
    return;
  }

  if (isLinear(el) && stroke) {
    let pts = resolvedPoints(doc, el).map(p => Q(p[0], p[1]));
    pts = trim(pts, progress);
    const cmds = [];
    if (el.type === "freedraw") {
      if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.5, pts[0][1] + 0.5]];
      smooth(cmds, pts);
      out.push({ t: "path", id: el.id, cmds, stroke, width: Math.max(1, width * 1.1), dash: null, opacity });
      return;
    }
    if (el.roundness && pts.length > 2) smooth(cmds, pts);   // Excalidraw's curved lines
    else sketch(cmds, pts, r, rough, false);
    out.push({ t: "path", id: el.id, cmds, stroke, width, dash, opacity });
    if (pts.length >= 2 && progress >= 1) {
      const strokes = [], fills = [];
      for (const [type, from, to] of [[el.endArrowhead, pts[pts.length - 2], pts[pts.length - 1]], [el.startArrowhead, pts[1], pts[0]]]) {
        if (!type) continue;
        const h = arrowheadCmds(type, from, to, 18 * s); strokes.push(...h.strokes); fills.push(...h.fills);
      }
      if (fills.length) out.push({ t: "path", id: el.id, cmds: fills, fill: stroke, opacity });
      if (strokes.length) out.push({ t: "path", id: el.id, cmds: strokes, stroke, width, dash: null, opacity });
    }
  }
}

// The whole board. `opts.time` (ms) plays the timeline; omit it for the editing view.
export function paintScene(doc, view, theme, opts = {}) {
  const out = [], P = project(view);
  for (const el of doc.visible()) paintElement(doc, el, P, view, theme, out, opts);
  return out;
}

// Helpers for overlays (selection, handles, cursors).
export function rectCmds(x, y, w, h) { return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["L", x, y]]; }
