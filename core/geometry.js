// Geometry on scene coordinates: boxes, hit testing, arrow binding, transforms.

import { isShape, isLinear, isLabel, textSize } from "./model.js";

export function bbox(el) {
  if (isLinear(el)) {
    const xs = el.points.map(p => p[0] + el.x), ys = el.points.map(p => p[1] + el.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (el.type === "text" && !el.containerId) {
    const s = textSize(el.text, el.fontSize, el.lineHeight);
    return { x: el.x, y: el.y, w: Math.max(el.width, s.w), h: Math.max(el.height, s.h) };
  }
  const x = Math.min(el.x, el.x + el.width), y = Math.min(el.y, el.y + el.height);
  return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) };
}

export function unionBox(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w)), y1 = Math.max(...boxes.map(b => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const inBox = (p, b, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
export const boxInBox = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Make width/height positive and linear boxes match their points.
export function normalize(el) {
  if (isShape(el) || el.type === "text") {
    if (el.width < 0) { el.x += el.width; el.width = -el.width; }
    if (el.height < 0) { el.y += el.height; el.height = -el.height; }
  }
  if (isLinear(el)) {
    // Keep (x, y) at the first point, as Excalidraw does.
    const [fx, fy] = el.points[0];
    if (fx || fy) { el.x += fx; el.y += fy; el.points = el.points.map(p => [p[0] - fx, p[1] - fy]); }
    const b = bbox(el); el.width = b.w; el.height = b.h;
  }
  return el;
}

export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from p to a shape's outline, negative inside.
export function outlineDistance(el, p) {
  const b = bbox(el), c = center(b), rx = b.w / 2 || 1, ry = b.h / 2 || 1;
  const dx = p.x - c.x, dy = p.y - c.y;
  if (el.type === "ellipse") return (Math.hypot(dx / rx, dy / ry) - 1) * Math.min(rx, ry);
  if (el.type === "diamond") return (Math.abs(dx) / rx + Math.abs(dy) / ry - 1) * Math.min(rx, ry) * 0.7;
  const ox = Math.abs(dx) - rx, oy = Math.abs(dy) - ry;
  return ox > 0 || oy > 0 ? Math.hypot(Math.max(ox, 0), Math.max(oy, 0)) : Math.max(ox, oy);
}

// Is p on this element? Transparent shapes are hit on their outline (or label),
// filled ones anywhere inside — as on a whiteboard.
export function hits(doc, el, p, tol) {
  if (isLabel(el)) return false;
  if (isLinear(el)) {
    const pts = resolvedPoints(doc, el);
    if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= tol + el.strokeWidth;
    for (let j = 1; j < pts.length; j++) if (distToSeg(p.x, p.y, pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]) <= tol + el.strokeWidth) return true;
    return false;
  }
  if (el.type === "text") return inBox(p, bbox(el), tol);
  if (el.type === "frame") { const b = bbox(el); return inBox(p, { x: b.x, y: b.y - 24, w: b.w, h: 24 }) || Math.abs(outlineDistance(el, p)) <= tol; }
  const d = outlineDistance(el, p);
  if (Math.abs(d) <= tol + el.strokeWidth) return true;
  if (d < 0 && (el.backgroundColor !== "transparent" || doc.labelOf(el))) return true;
  return false;
}

// Topmost precise hit (an outline, a filled shape, text, a line). Failing that, the
// smallest unfilled shape the point is inside: empty boxes are selectable from
// anywhere inside, but a big one drawn on top doesn't block the shapes under it.
// Frames stay click-through inside so a marquee can start within them.
export function hitTest(doc, p, tol = 6) {
  const els = doc.visible();
  for (let i = els.length - 1; i >= 0; i--) if (hits(doc, els[i], p, tol)) return els[i];
  let best = null, area = Infinity;
  for (const el of els) {
    if (!isShape(el) || el.type === "frame" || outlineDistance(el, p) > 0) continue;
    const b = bbox(el), a = b.w * b.h;
    if (a < area) { best = el; area = a; }
  }
  return best;
}

// The topmost shape whose box contains p (arrow binding targets).
export function shapeAt(doc, p, except) {
  const els = doc.visible();
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!isShape(el) || el.type === "frame" || el.id === except) continue;
    if (inBox(p, bbox(el), 4)) return el;
  }
  return null;
}

// Where a ray from a shape's center toward (tx, ty) leaves its outline, plus gap.
export function edgePoint(el, tx, ty, gap = 6) {
  const b = bbox(el), c = center(b), rx = b.w / 2 || 1, ry = b.h / 2 || 1;
  const dx = tx - c.x, dy = ty - c.y, len = Math.hypot(dx, dy) || 1;
  let t;
  if (el.type === "ellipse") t = 1 / (Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2) || 1);
  else if (el.type === "diamond") t = 1 / ((Math.abs(dx) / rx + Math.abs(dy) / ry) || 1);
  else t = 1 / (Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry) || 1);
  return [c.x + dx * t + (dx / len) * gap, c.y + dy * t + (dy / len) * gap];
}

// Absolute points of a linear element, with bound ends snapped to their
// shapes' outlines. Agents set only startBinding/endBinding; this does the rest.
export function resolvedPoints(doc, el) {
  const pts = el.points.map(p => [p[0] + el.x, p[1] + el.y]);
  if (el.type === "freedraw" || pts.length < 2) return pts;
  const s = el.startBinding && doc.get(el.startBinding.elementId), e = el.endBinding && doc.get(el.endBinding.elementId);
  const cOf = x => { const c = center(bbox(x)); return [c.x, c.y]; };
  if (s) { const to = e && pts.length === 2 ? cOf(e) : pts[1]; pts[0] = edgePoint(s, to[0], to[1], el.startBinding.gap ?? 6); }
  if (e) { const from = s && pts.length === 2 ? cOf(s) : pts[pts.length - 2]; pts[pts.length - 1] = edgePoint(e, from[0], from[1], el.endBinding.gap ?? 6); }
  return pts;
}

// Bake resolved arrow geometry into the element, so other tools see it right.
export function settle(doc, el) {
  if ((el.type !== "arrow" && el.type !== "line") || (!el.startBinding && !el.endBinding)) return false;
  const pts = resolvedPoints(doc, el);
  const next = pts.map(p => [p[0] - pts[0][0], p[1] - pts[0][1]]);
  if (el.x === pts[0][0] && el.y === pts[0][1] && JSON.stringify(next) === JSON.stringify(el.points)) return false;
  el.x = pts[0][0]; el.y = pts[0][1]; el.points = next;
  const b = bbox(el); el.width = b.w; el.height = b.h;
  return true;
}

// Map an element from box `from` into box `to` (resizing a selection).
export function mapIntoBox(el, orig, from, to) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const mx = x => to.x + (x - from.x) * sx, my = y => to.y + (y - from.y) * sy;
  if (isLinear(orig)) {
    el.x = mx(orig.x); el.y = my(orig.y);
    el.points = orig.points.map(p => [p[0] * sx, p[1] * sy]);
    const b = bbox(el); el.width = b.w; el.height = b.h;
  } else {
    el.x = mx(orig.x); el.y = my(orig.y); el.width = orig.width * sx; el.height = orig.height * sy;
    if (el.type === "text" && !el.containerId) el.fontSize = Math.max(6, orig.fontSize * Math.min(Math.abs(sx), Math.abs(sy)));
  }
}

export function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
