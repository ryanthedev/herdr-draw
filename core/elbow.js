// Elbow arrows: right-angle routes between two shapes (Excalidraw's `elbowed: true`).
//
// The route leaves the start shape from the side that faces the target and
// enters the end shape from the side that faces back, with a short straight
// stub at each end, then joins the stubs with one or two bends:
//   facing sides (→ ←): a Z, bending halfway;  perpendicular sides: an L;
//   sides facing away (→ →, or blocked): a U around both shapes.
// It never cuts through either end shape. When the simple route crosses another
// shape, alternatives (other sides, shifted runs, detours around) are scored by
// crossings, then length and bends, and the best one wins.

const STUB = 24;     // straight run out of a side before the first bend
const AROUND = 24;   // clearance when going around a shape

const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const horizontal = side => side === "left" || side === "right";

// The side of box `b` that faces point p (by the larger axis of separation).
export function facingSide(b, p) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = (p.x - cx) / Math.max(b.w, 1), dy = (p.y - cy) / Math.max(b.h, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export function sidePoint(b, side, gap = 0) {
  const [nx, ny] = NORMAL[side];
  if (horizontal(side)) return { x: (side === "right" ? b.x + b.w : b.x) + nx * gap, y: b.y + b.h / 2 };
  return { x: b.x + b.w / 2, y: (side === "bottom" ? b.y + b.h : b.y) + ny * gap };
}

// Drop repeated points and middle points of straight runs.
export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.01 && Math.abs(out[out.length - 1].y - p.y) < 0.01) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const straight = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
      if (!straight) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

const SIDES = ["right", "left", "bottom", "top"];

// Route from `from` to `to`. Each end is { box, side?, point? }: a bound shape's box
// (side chosen if not given) or a free point. `gap` keeps the ends off the outlines.
// `obstacles`: other shapes' boxes the route should not cross.
export function elbowRoute(from, to, gap = 6, obstacles = []) {
  const first = basicRoute(from, to, gap);
  const near = nearby(obstacles, first.points, from, to);
  if (!near.length || !crossings(first.points, near)) return first;
  let best = { r: first, score: score(first.points, near) };
  const sidesFrom = from.box && !from.side ? SIDES : [first.sides[0]], sidesTo = to.box && !to.side ? SIDES : [first.sides[1]];
  for (const sf of sidesFrom) for (const st of sidesTo) {
    for (const variant of ["mid", "early", "late", "over", "under"]) {
      const r = basicRoute({ ...from, side: sf }, { ...to, side: st }, gap, variant, near);
      const sc = score(r.points, near);
      if (sc < best.score) best = { r, score: sc };
    }
  }
  return best.r;
}

// Only shapes near the route matter (keeps routing cheap on big boards).
function nearby(obstacles, pts, from, to) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), m = 200;
  const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
  return obstacles.filter(b => b !== from.box && b !== to.box && b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0);
}

// How many (segment, box) pairs cross through a box's inside.
export function crossings(pts, boxes) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], p = pts[i], minx = Math.min(a.x, p.x), maxx = Math.max(a.x, p.x), miny = Math.min(a.y, p.y), maxy = Math.max(a.y, p.y);
    for (const b of boxes) if (maxx > b.x + 0.5 && minx < b.x + b.w - 0.5 && maxy > b.y + 0.5 && miny < b.y + b.h - 0.5) n++;
  }
  return n;
}

function score(pts, boxes) {
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
  return crossings(pts, boxes) * 1e6 + len + (pts.length - 2) * 40;
}

// One route for fixed sides. `variant` moves the middle run: "mid" (halfway), "early"/"late"
// (right after / before the stubs), "over"/"under" (a detour beyond everything in `boxes`).
function basicRoute(from, to, gap, variant = "mid", boxes = []) {
  const fc = from.box ? { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h / 2 } : from.point;
  const tc = to.box ? { x: to.box.x + to.box.w / 2, y: to.box.y + to.box.h / 2 } : to.point;
  // Free ends get a virtual side: the one pointing toward the other end.
  const sideFrom = from.side ?? (from.box ? facingSide(from.box, tc) : facingSide({ x: fc.x, y: fc.y, w: 0, h: 0 }, tc));
  const sideTo = to.side ?? (to.box ? facingSide(to.box, fc) : facingSide({ x: tc.x, y: tc.y, w: 0, h: 0 }, fc));
  const a = from.box ? sidePoint(from.box, sideFrom, gap) : fc;
  const b = to.box ? sidePoint(to.box, sideTo, gap) : tc;
  const [ax, ay] = NORMAL[sideFrom], [bx, by] = NORMAL[sideTo];
  const stubA = from.box ? STUB : 0, stubB = to.box ? STUB : 0;
  const pa = { x: a.x + ax * stubA, y: a.y + ay * stubA }, pb = { x: b.x + bx * stubB, y: b.y + by * stubB };
  const mid = [];
  const hA = horizontal(sideFrom), hB = horizontal(sideTo);
  if (hA && hB) {
    const facing = Math.sign(pb.x - pa.x) === ax && ax === -bx;
    if (facing && (variant === "over" || variant === "under")) {
      const all = [from.box, to.box, ...boxes].filter(Boolean);
      const y = variant === "over" ? Math.min(...all.map(q => q.y)) - AROUND : Math.max(...all.map(q => q.y + q.h)) + AROUND;
      mid.push({ x: pa.x, y }, { x: pb.x, y });
    } else if (facing) { const mx = variant === "early" ? pa.x : variant === "late" ? pb.x : (pa.x + pb.x) / 2; mid.push({ x: mx, y: pa.y }, { x: mx, y: pb.y }); }
    else {   // around: over or under both shapes, whichever is shorter
      const top = Math.min(from.box?.y ?? pa.y, to.box?.y ?? pb.y) - AROUND;
      const bottom = Math.max((from.box ? from.box.y + from.box.h : pa.y), (to.box ? to.box.y + to.box.h : pb.y)) + AROUND;
      const y = Math.abs(pa.y - top) + Math.abs(pb.y - top) <= Math.abs(pa.y - bottom) + Math.abs(pb.y - bottom) ? top : bottom;
      mid.push({ x: pa.x, y }, { x: pb.x, y });
    }
  } else if (!hA && !hB) {
    const facing = Math.sign(pb.y - pa.y) === ay && ay === -by;
    if (facing && (variant === "over" || variant === "under")) {
      const all = [from.box, to.box, ...boxes].filter(Boolean);
      const x = variant === "over" ? Math.min(...all.map(q => q.x)) - AROUND : Math.max(...all.map(q => q.x + q.w)) + AROUND;
      mid.push({ x, y: pa.y }, { x, y: pb.y });
    } else if (facing) { const my = variant === "early" ? pa.y : variant === "late" ? pb.y : (pa.y + pb.y) / 2; mid.push({ x: pa.x, y: my }, { x: pb.x, y: my }); }
    else {
      const left = Math.min(from.box?.x ?? pa.x, to.box?.x ?? pb.x) - AROUND;
      const right = Math.max((from.box ? from.box.x + from.box.w : pa.x), (to.box ? to.box.x + to.box.w : pb.x)) + AROUND;
      const x = Math.abs(pa.x - left) + Math.abs(pb.x - left) <= Math.abs(pa.x - right) + Math.abs(pb.x - right) ? left : right;
      mid.push({ x, y: pa.y }, { x, y: pb.y });
    }
  } else {
    // One horizontal side, one vertical: a single bend where the two runs meet.
    mid.push(hA ? { x: pb.x, y: pa.y } : { x: pa.x, y: pb.y });
  }
  return { points: simplify([a, pa, ...mid, pb, b]), sides: [sideFrom, sideTo] };
}
