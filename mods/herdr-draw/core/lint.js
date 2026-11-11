// Overlap checks for a board as it is drawn (after settle + fileScene): label words wider than their
// shape allows, shapes partly covering each other, edges through shapes other than their ends, edge labels on shapes or on each other,
// edges through another edge's label, frame titles on anything, two edges drawn on top of each other.
// overlaps(elements) → [{ msg, ids }] ([] = clean); ids are the elements to move or fix.
// Boxes are unrotated. Used by the Mermaid layout (elbows that collide fall back to lanes), `drawh check` and the tests.
import { Doc } from "./doc.js";
import { settle, fileScene, drawnPoints, bbox, segmentsIntersect } from "./geometry.js";
import { isShape, isLinear, clone } from "./model.js";
import { textWidth, labelWidthFactor, labelHostWidth, LABEL_PAD } from "./text.js";

export function drawnScene(elements) {
  const doc = new Doc({ elements });
  for (const el of doc.live()) if (isLinear(el) && (el.elbowed || el.startBinding || el.endBinding)) {
    const c = clone(el); if (settle(doc, c)) doc.apply({ elements: [c] }, { force: true });
  }
  return new Doc(fileScene(doc, doc.toScene()));
}

const overlap = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const segHitsBox = (p, q, b) => {
  const inside = pt => pt[0] > b.x && pt[0] < b.x + b.w && pt[1] > b.y && pt[1] < b.y + b.h;
  if (inside(p) || inside(q)) return true;
  const c = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  return c.some((a, i) => segmentsIntersect(p, q, a, c[(i + 1) % 4]));
};

export function overlaps(elements) {
  const doc = drawnScene(elements), live = doc.live(), out = [];
  const add = (msg, ...ids) => out.push({ msg, ids });
  const name = el => JSON.stringify(doc.labelOf(el)?.text ?? el.id);
  const edgeName = e => { const a = doc.get(e.startBinding?.elementId), b = doc.get(e.endBinding?.elementId); return a && b ? `edge ${name(a)}→${name(b)}` : `${e.type} ${e.id}`; };
  const shapes = live.filter(e => isShape(e) && e.type !== "frame");
  // Edges: arrows and lines bound at one end at least (an unbound line is a drawing, not a connection).
  const edges = live.filter(e => (e.type === "arrow" || e.type === "line") && (e.startBinding || e.endBinding));
  // A shape drawn around one of an edge's ends is its container: the edge and its label belong inside it.
  const holds = (outer, inner) => { if (!inner) return false; const o = box(outer), i = box(inner); return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h; };
  const container = (e, s) => s.id !== e.startBinding?.elementId && s.id !== e.endBinding?.elementId &&
    (holds(s, doc.get(e.startBinding?.elementId)) || holds(s, doc.get(e.endBinding?.elementId)));
  const box = el => bbox({ ...el, angle: 0 });
  // 1. every word of a shape's label fits inside it whole (a wider one is broken across lines)
  for (const s of shapes) {
    const l = doc.labelOf(s); if (!l?.text) continue;
    const usable = Math.abs(s.width) * labelWidthFactor(s.type) - LABEL_PAD * 2;
    const words = [...new Set(String(l.text).split(/[ \n]+/).filter(Boolean))];
    for (const word of words) { const w = textWidth(word, l.fontSize, l.fontFamily); if (w > usable + 0.5) add(`${JSON.stringify(word)} doesn't fit whole in ${s.type} ${name(s)}: ${w.toFixed(0)}px, room for ${Math.max(0, usable).toFixed(0)}px (make it ${labelHostWidth(l, s.type)} wide)`, s.id); }
  }
  // 2. shapes don't partly cover each other (one wholly inside another is a container: fine)
  for (const a of shapes) for (const b of shapes) if (a.id < b.id) {
    const A = box(a), B = box(b), inside = (p, q) => p.x >= q.x && p.y >= q.y && p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
    if (overlap(A, B) && !inside(A, B) && !inside(B, A)) add(`${a.type} ${name(a)} and ${b.type} ${name(b)} overlap`, a.id, b.id);
  }
  // 3. an edge crosses no shape but its two ends (a small inset: ends sit 6px off the outline)
  const segsOf = e => { const p = drawnPoints(doc, e); return p.slice(1).map((q, i) => [p[i], q]); };
  for (const e of edges) for (const s of shapes) {
    if (s.id === e.startBinding?.elementId || s.id === e.endBinding?.elementId || container(e, s)) continue;
    const b = box(s), inset = { x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4 };
    if (segsOf(e).some(([p, q]) => segHitsBox(p, q, inset))) add(`${edgeName(e)} crosses ${name(s)}`, e.id, s.id);
  }
  // 4. edge labels: off every shape, off each other, and no other edge runs through them
  const elabels = live.filter(t => t.type === "text" && t.containerId && edges.includes(doc.get(t.containerId)));
  for (const t of elabels) {
    const b = { x: t.x, y: t.y, w: t.width, h: t.height };
    for (const s of shapes) if (overlap(b, box(s)) && !container(doc.get(t.containerId), s)) add(`edge label ${JSON.stringify(t.text)} sits on ${name(s)}`, t.containerId, s.id);
    for (const u of elabels) if (u !== t && u.id > t.id && overlap(b, { x: u.x, y: u.y, w: u.width, h: u.height })) add(`edge labels ${JSON.stringify(t.text)} and ${JSON.stringify(u.text)} overlap`, t.containerId, u.containerId);
    for (const e of edges) if (e.id !== t.containerId && segsOf(e).some(([p, q]) => segHitsBox(p, q, b))) add(`${edgeName(e)} runs through edge label ${JSON.stringify(t.text)}`, e.id, t.containerId);
  }
  // 5. frame titles (drawn just above the frame's top-left corner, as core/render.js does) stay clear
  for (const f of live.filter(e => e.type === "frame")) {
    const b = { x: f.x, y: f.y - 18, w: textWidth(f.name || "Frame", 14, 2), h: 17 }, title = JSON.stringify(f.name || "Frame");
    for (const s of shapes) if (overlap(b, box(s))) add(`frame title ${title} sits on ${name(s)}`, f.id, s.id);
    for (const t of elabels) if (overlap(b, { x: t.x, y: t.y, w: t.width, h: t.height })) add(`frame title ${title} and edge label ${JSON.stringify(t.text)} overlap`, f.id, t.containerId);
    for (const e of edges) if (segsOf(e).some(([p, q]) => segHitsBox(p, q, b))) add(`${edgeName(e)} runs through frame title ${title}`, e.id, f.id);
  }
  // 6. two edges drawn on top of each other (same ends, opposite ways)
  for (const e of edges) for (const f of edges) if (e.id < f.id) {
    const pe = drawnPoints(doc, e), pf = drawnPoints(doc, f);
    const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 3;
    if (pe.length === pf.length && pe.every((p, i) => same(p, pf[pf.length - 1 - i]) || same(p, pf[i]))) add(`${edgeName(e)} and ${edgeName(f)} are drawn on top of each other`, e.id, f.id);
  }
  return out;
}
