// Excalidraw's drawing vocabulary, so files from excalidraw.com look the same here:
// rounded corners (roundness), fill styles (hachure, cross-hatch), arrowhead types
// and font families. Pure geometry: everything returns points or path commands.

// Excalidraw's corner radius: type 2 is proportional (25% of the shorter side);
// type 3 ("adaptive", the default for new rectangles there) caps at 32.
export function cornerRadius(el, size) {
  const r = el.roundness;
  if (!r) return 0;
  if (r.type === 2) return size * 0.25;
  return size <= 128 ? size * 0.25 : 32;
}

// A closed polygon with its corners rounded by quadratic curves, as points.
export function roundPolygon(corners, radius, steps = 6) {
  if (radius <= 0) return [...corners, corners[0]];
  const out = [], n = corners.length;
  for (let i = 0; i < n; i++) {
    const v = corners[i], prev = corners[(i + n - 1) % n], next = corners[(i + 1) % n];
    const lp = Math.hypot(prev[0] - v[0], prev[1] - v[1]) || 1, ln = Math.hypot(next[0] - v[0], next[1] - v[1]) || 1;
    const tp = Math.min(0.5, radius / lp), tn = Math.min(0.5, radius / ln);
    const a = [v[0] + (prev[0] - v[0]) * tp, v[1] + (prev[1] - v[1]) * tp], b = [v[0] + (next[0] - v[0]) * tn, v[1] + (next[1] - v[1]) * tn];
    for (let k = 0; k <= steps; k++) {   // quadratic from a to b with v as the control point
      const t = k / steps, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * v[0] + t * t * b[0], u * u * a[1] + 2 * u * t * v[1] + t * t * b[1]]);
    }
  }
  out.push(out[0]);
  return out;
}

// Parallel lines filling a polygon (screen points), at `angle` radians, `gap` apart.
// Returns segments [[x1, y1], [x2, y2]].
// Board files come from anywhere: non-finite sizes give no lines, and a huge shape
// (or extreme zoom) widens the gap so there are never more than MAX_HATCH lines.
const MAX_HATCH = 1500;
export function hatchLines(poly, angle, gap) {
  if (poly.length < 3 || !(gap > 0) || !Number.isFinite(angle) || poly.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return [];
  const c = Math.cos(-angle), s = Math.sin(-angle);
  const rot = ([x, y]) => [x * c - y * s, x * s + y * c];
  const back = ([x, y]) => [x * c + y * s, -x * s + y * c];
  const p = poly.map(rot);
  const ys = p.map(q => q[1]), y0 = Math.min(...ys), y1 = Math.max(...ys), out = [];
  // An integer count, not `y += gap`: at huge coordinates adding the gap can leave y unchanged.
  const n = Math.min(MAX_HATCH, Math.floor((y1 - y0) / gap));
  if (!(n > 0)) return out;
  const step = (y1 - y0) / n;
  for (let k = 0; k < n; k++) {
    const y = y0 + (k + 0.5) * step;
    const xs = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([back([xs[i], y]), back([xs[i + 1], y])]);
  }
  return out;
}

export const HACHURE_ANGLE = (-41 * Math.PI) / 180;   // roughjs / Excalidraw

// Fill-style lines for a shape outline (screen points): hachure, cross-hatch or zigzag.
export function fillLines(style, poly, strokeWidthPx) {
  const gap = Math.max(4, strokeWidthPx * 4);
  if (style === "cross-hatch") return [...hatchLines(poly, HACHURE_ANGLE, gap), ...hatchLines(poly, HACHURE_ANGLE + Math.PI / 2, gap)];
  return hatchLines(poly, HACHURE_ANGLE, gap);   // hachure; zigzag draws as hachure
}

export const ARROWHEADS = ["arrow", "triangle", "triangle_outline", "dot", "circle", "circle_outline", "bar", "diamond", "diamond_outline"];

// An arrowhead at `to`, pointing away from `from`. Returns { strokes, fills } path commands.
export function arrowheadCmds(type, from, to, size) {
  const strokes = [], fills = [];
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const L = Math.min(size, len), a = Math.atan2(dy, dx);   // callers aim from `size` back along the line
  const at = (back, side) => [to[0] - ux * back - uy * side, to[1] - uy * back + ux * side];
  const poly = (pts, filled) => { const c = pts.map((p, i) => [i ? "L" : "M", p[0], p[1]]); if (filled) fills.push(...c); else strokes.push(...c, ["L", pts[0][0], pts[0][1]]); };
  switch (type) {
    case "triangle": case "triangle_outline": {
      const w = L * Math.tan(0.45);
      poly([to, at(L, w), at(L, -w)], type === "triangle");
      break;
    }
    case "dot": case "circle": case "circle_outline": {
      const r = L * 0.3, c = at(r, 0), pts = [];
      for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; pts.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]); }
      poly(pts, type !== "circle_outline");
      break;
    }
    case "bar": strokes.push(["M", ...at(0, L * 0.45)], ["L", ...at(0, -L * 0.45)]); break;
    case "diamond": case "diamond_outline": {
      const w = L * 0.3;
      poly([to, at(L * 0.5, w), at(L, 0), at(L * 0.5, -w)], type === "diamond");
      break;
    }
    default:   // "arrow": one stroke wing, tip, wing, so the tip is a clean join
      strokes.push(["M", to[0] - Math.cos(a - 0.45) * L, to[1] - Math.sin(a - 0.45) * L], ["L", to[0], to[1]], ["L", to[0] - Math.cos(a + 0.45) * L, to[1] - Math.sin(a + 0.45) * L]);
  }
  return { strokes, fills };
}

// Excalidraw font families → a face class the adapters map to real fonts.
// 1 Virgil, 5 Excalifont, 8 Comic Shanns: hand; 3 Cascadia: mono; 2 Helvetica, 6 Nunito, 7 Lilita: sans.
export function fontClass(fontFamily) {
  if (fontFamily === 1 || fontFamily === 5 || fontFamily === 8) return "hand";
  if (fontFamily === 3) return "mono";
  return "sans";
}
export const FONT_FAMILY = { hand: 5, sans: 2, mono: 3 };
