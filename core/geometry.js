// Geometry on scene coordinates: boxes, hit testing, arrow binding, transforms.

import { isShape, isLinear, isLabel, textSize } from "./model.js";
import { elbowRoute } from "./elbow.js";

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

// ── rotation ──────────────────────────────────────────────────────────────
// Shapes and text keep Excalidraw's `angle` (radians, clockwise, about the
// center of their unrotated box). Lines, arrows and pen strokes have their
// rotation baked into their points instead, so arrow binding stays simple.

export function rotate(p, c, a) {
  if (!a) return { x: p.x, y: p.y };
  const s = Math.sin(a), k = Math.cos(a), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * k - dy * s, y: c.y + dx * s + dy * k };
}
export const angleOf = el => (isLinear(el) ? 0 : el.angle || 0);
export const centerOf = el => center(bbox(el));
// A scene point in the element's own unrotated frame.
export const toLocal = (el, p) => rotate(p, centerOf(el), -angleOf(el));
export const toWorld = (el, p) => rotate(p, centerOf(el), angleOf(el));

// The four corners of the element's box, rotated.
export function corners(el) {
  const b = bbox(el);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => toWorld(el, { x, y }));
}

// The axis-aligned box around the element as drawn (rotation included).
export function bounds(el) {
  if (!angleOf(el)) return bbox(el);
  const cs = corners(el), xs = cs.map(c => c.x), ys = cs.map(c => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Turn an element by `da` about point `c` (a group's center): shapes move their
// center and add to their angle; linear elements rotate their points.
export function rotateAbout(el, orig, c, da) {
  if (isLinear(orig)) {
    const pts = orig.points.map(p => rotate({ x: orig.x + p[0], y: orig.y + p[1] }, c, da));
    el.x = pts[0].x; el.y = pts[0].y;
    el.points = pts.map(p => [p.x - pts[0].x, p.y - pts[0].y]);
    const b = bbox(el); el.width = b.w; el.height = b.h;
    return;
  }
  const oc = centerOf(orig), nc = rotate(oc, c, da), b = bbox(orig);
  el.x = nc.x - b.w / 2; el.y = nc.y - b.h / 2;
  el.angle = normAngle((orig.angle || 0) + da);
}
export function normAngle(a) { const t = Math.PI * 2; a %= t; if (a < 0) a += t; return Math.abs(a) < 1e-9 || Math.abs(a - t) < 1e-9 ? 0 : a; }

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
  p = toLocal(el, p);
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
  if (el.type === "text") return inBox(toLocal(el, p), bbox(el), tol);
  if (el.type === "frame") { const b = bbox(el); return inBox(toLocal(el, p), { x: b.x, y: b.y - 24, w: b.w, h: 24 }) || Math.abs(outlineDistance(el, p)) <= tol; }
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
    if (inBox(toLocal(el, p), bbox(el), 4)) return el;
  }
  return null;
}

// Where a ray from a shape's center toward (tx, ty) leaves its outline, plus gap.
export function edgePoint(el, tx, ty, gap = 6) {
  const a = angleOf(el);
  if (a) {   // work in the shape's own frame, then turn the answer back
    const t = toLocal(el, { x: tx, y: ty }), q = edgePoint({ ...el, angle: 0 }, t.x, t.y, gap), w = toWorld(el, { x: q[0], y: q[1] });
    return [w.x, w.y];
  }
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
  if (el.elbowed) {   // right angles, routed from the ends (bound shapes, or the first/last points), around other shapes
    const key = `${doc.rev}|${el.id}|${el.version}`;
    const memo = (doc._elbow ??= new Map());
    if (memo.get(el.id)?.key === key) return memo.get(el.id).pts.map(p => [...p]);
    const end = p => ({ point: { x: p[0], y: p[1] } });
    const fromBox = s ? bounds(s) : null, toBox = e ? bounds(e) : null;
    const obstacles = doc.visible().filter(o => isShape(o) && o.type !== "frame" && o !== s && o !== e).map(bounds);
    const r = elbowRoute(fromBox ? { box: fromBox } : end(pts[0]), toBox ? { box: toBox } : end(pts[pts.length - 1]), el.startBinding?.gap ?? el.endBinding?.gap ?? 6, obstacles);
    const out = r.points.map(p => [p.x, p.y]);
    memo.set(el.id, { key, pts: out });
    return out.map(p => [...p]);
  }
  const cOf = x => { const c = center(bbox(x)); return [c.x, c.y]; };
  if (s) { const to = e && pts.length === 2 ? cOf(e) : pts[1]; pts[0] = edgePoint(s, to[0], to[1], el.startBinding.gap ?? 6); }
  if (e) { const from = s && pts.length === 2 ? cOf(s) : pts[pts.length - 2]; pts[pts.length - 1] = edgePoint(e, from[0], from[1], el.endBinding.gap ?? 6); }
  return pts;
}

// Bake resolved arrow geometry into the element, so other tools see it right.
export function settle(doc, el) {
  if ((el.type !== "arrow" && el.type !== "line") || (!el.startBinding && !el.endBinding && !el.elbowed)) return false;
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

// The point a fraction of the way along a polyline (by length): where an arrow's label sits.
export function alongPath(pts, f = 0.5) {
  let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * f;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (seg >= left) { const k = seg ? left / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
    left -= seg;
  }
  return pts[pts.length - 1];
}

export function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
