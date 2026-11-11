// Arrows: drawn sharp (heads meet the shaft), smooth (curves through their points).
import { test, expect } from "bun:test";
import { Doc } from "../core/doc.js";
import { makeElement } from "../core/model.js";
import { paintScene } from "../core/render.js";
import { curveThrough, drawnPoints, hits } from "../core/geometry.js";

const THEME = { fg: "#e6e6e6", bg: "#000000", accent: "#5eead4", dim: "#6b7280" };
const view = { x: 0, y: 0, scale: 1 };
const arrow = (points, f = {}) => makeElement("arrow", { x: 0, y: 0, points, endArrowhead: "arrow", ...f });
const paint = (...els) => paintScene(new Doc({ elements: els }), view, THEME);
const end = cmds => { const c = cmds[cmds.length - 1]; return [c[1], c[2]]; };

test("a curve passes through every point it was given", () => {
  const pts = [[0, 0], [100, -60], [200, 0], [300, 40]];
  const c = curveThrough(pts);
  for (const p of pts) expect(c.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6)).toBe(true);
  expect(c.length).toBeGreaterThan(30);
});

test("a sketchy arrow's shaft ends exactly at the head's tip", () => {
  for (const roughness of [0, 1, 2]) {
    const a = arrow([[0, 0], [180, 70]], { roughness, seed: 7 });
    const [shaft, head] = paint(a);
    const tip = head.cmds.find((c, i) => i === 1);   // wing, tip, wing
    expect(end(shaft.cmds)).toEqual([180, 70]);
    expect([tip[1], tip[2]]).toEqual([180, 70]);
  }
});

test("a sketchy arrow is one pass; loose is two", () => {
  const moves = r => paint(arrow([[0, 0], [200, 0]], { roughness: r }))[0].cmds.filter(c => c[0] === "M").length;
  expect(moves(1)).toBe(1);
  expect(moves(2)).toBe(2);
});

test("on a curve the head follows the curve, not the last tiny step", () => {
  // Ends going straight down: the head's wings must sit above the tip, symmetric about it.
  const a = arrow([[0, 0], [120, -40], [200, 100]], { roundness: { type: 2 } });
  const [, head] = paint(a);
  const [w1, tip, w2] = head.cmds.map(c => [c[1], c[2]]);
  expect(tip).toEqual([200, 100]);
  const dir = drawnPoints(new Doc({ elements: [a] }), a), back = dir[dir.length - 4];
  const tangent = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
  const mid = [(w1[0] + w2[0]) / 2, (w1[1] + w2[1]) / 2], aim = Math.atan2(tip[1] - mid[1], tip[0] - mid[0]);
  expect(Math.abs(aim - tangent)).toBeLessThan(0.25);
});

test("heads grow with the stroke, but never swallow a short arrow", () => {
  const len = a => { const h = paint(a)[1].cmds; return Math.hypot(h[0][1] - h[1][1], h[0][2] - h[1][2]); };
  expect(len(arrow([[0, 0], [300, 0]], { strokeWidth: 4 }))).toBeGreaterThan(len(arrow([[0, 0], [300, 0]], { strokeWidth: 1 })));
  expect(len(arrow([[0, 0], [30, 0]], { strokeWidth: 4 }))).toBeLessThanOrEqual(10 + 1e-9);
});

test("a curved arrow is hit on its curve, not on the straight chord", () => {
  const a = arrow([[0, 0], [100, -80], [200, 0]], { roundness: { type: 2 } });
  const doc = new Doc({ elements: [a] });
  expect(hits(doc, a, { x: 100, y: -80 }, 4)).toBe(true);
  expect(hits(doc, a, { x: 100, y: 0 }, 4)).toBe(false);
});

// ── attaching: precise targets, live preview, connection points, cursors ──
import { setup } from "./harness/fixture.js";
import { resolvedPoints, portsOf, settle } from "../core/geometry.js";

const boxAt = (t, tool, from, to) => { t.key(tool); t.drag(from, to); return t.ed.doc.get([...t.ed.sel][0]); };

test("an arrow ending in a diamond's empty corner doesn't attach; on the diamond it does", () => {
  const t = setup();
  const d = boxAt(t, "d", [300, 100], [500, 300]);       // diamond: corners of its box are empty
  t.key("a"); t.drag([100, 400], [310, 110]);             // top-left corner of the box, off the diamond
  expect(t.byType("arrow")[0].endBinding).toBe(null);
  t.key("a"); t.drag([100, 450], [400, 200]);             // inside
  expect(t.byType("arrow")[1].endBinding?.elementId).toBe(d.id);
});

test("the end attaches while dragging, so nothing jumps on release", () => {
  const t = setup();
  const r = boxAt(t, "r", [300, 100], [460, 220]);
  t.key("a");
  t.ed.pointerDown({ x: 60, y: 160 }, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) t.ed.pointerMove({ x: 60 + i * 50, y: 160 }, {});   // ends at x 360, inside the box
  const live = t.ed.doc.get(t.ed.g.el.id);
  expect(live.endBinding?.elementId).toBe(r.id);
  const drawnEnd = resolvedPoints(t.ed.doc, live).at(-1);
  expect(drawnEnd[0]).toBeCloseTo(294, 0);                // on the left edge (300), gap 6, before release
  t.ed.pointerUp({ x: 360, y: 160 }, {});
  expect(resolvedPoints(t.ed.doc, t.byType("arrow")[0]).at(-1)).toEqual(drawnEnd);
});

test("an end near a connection point takes it, and stays there when the shape moves", () => {
  const t = setup();
  const r = boxAt(t, "r", [300, 100], [460, 220]);
  t.key("a"); t.drag([100, 400], [383, 103]);             // near the top middle (380, 100)
  const a = t.byType("arrow")[0];
  expect(a.endBinding.elementId).toBe(r.id);
  expect(a.endBinding.fixedPoint[0]).toBeCloseTo(0.5, 3);
  const e0 = resolvedPoints(t.ed.doc, a).at(-1);
  expect(e0[0]).toBeCloseTo(380, 1); expect(e0[1]).toBeCloseTo(94, 6);   // fixedPoint 0.5 is stored as 0.5001, as excalidraw.com does
  t.key("escape"); t.drag([300, 160], [500, 260]);        // move the box by (200, 100) from its edge
  const moved = t.ed.doc.get(r.id), end = resolvedPoints(t.ed.doc, t.ed.doc.get(a.id)).at(-1);
  expect(end[0]).toBeCloseTo(moved.x + moved.width / 2, 1);
  expect(end[1]).toBeCloseTo(moved.y - 6, 6);
  // Saved as is (excalidraw.com keeps a fixedPoint on any arrow now).
  const doc = t.ed.doc, c = structuredClone(doc.get(a.id)); settle(doc, c);
  expect(c.endBinding.fixedPoint).toEqual(a.endBinding.fixedPoint);
});

test("a fixedPoint inside the shape (excalidraw.com's aim point) doesn't pin the end", () => {
  const t = setup();
  const r = boxAt(t, "r", [300, 100], [460, 220]);
  t.key("a"); t.drag([100, 160], [380, 160]);
  const a = structuredClone(t.byType("arrow")[0]);
  a.endBinding = { ...a.endBinding, fixedPoint: [0.5, 0.5] };
  expect(resolvedPoints(t.ed.doc, a).at(-1)[0]).toBeCloseTo(294, 0);
});

test("⌘ held: the arrow doesn't attach", () => {
  const t = setup();
  boxAt(t, "r", [300, 100], [460, 220]);
  t.key("a"); t.drag([100, 160], [380, 160], { cmd: true });
  expect(t.byType("arrow")[0].endBinding).toBe(null);
});

test("with the arrow tool, a shape under the pointer shows its connection points and the cursor says so", () => {
  const t = setup();
  const r = boxAt(t, "r", [300, 100], [460, 220]);
  t.key("a");
  const theme = { fg: "#fff", bg: "#000", accent: "#5eead4", dim: "#666" };
  t.ed.pointerMove({ x: 100, y: 400 }, {});
  expect(t.ed.cursor()).toBe("crosshair");
  const plain = t.ed.displayList(theme).length;
  t.ed.pointerMove({ x: 380, y: 102 }, {});                // on the top connection point
  expect(t.ed.cursor()).toBe("pointer");
  expect(t.ed.hint.fixedPoint).toEqual(portsOf(r)[0].fixedPoint);
  expect(t.ed.displayList(theme).length).toBe(plain + 1 + 4 * 2);   // outline + 4 rings (fill + stroke)
});

test("select-tool cursors: resize handles, rotate, elements, empty space", () => {
  const t = setup();
  boxAt(t, "r", [300, 100], [460, 220]);
  t.key("v");
  const at = p => { t.ed.pointerMove(p, {}); return t.ed.cursor(); };
  const h = Object.fromEntries(t.ed.handles().map(x => [x.dir ?? x.kind, x]));
  expect(at(h.nw)).toBe("nwse-resize");
  expect(at(h.ne)).toBe("nesw-resize");
  expect(at(h.s)).toBe("ns-resize");
  expect(at(h.e)).toBe("ew-resize");
  expect(at(h.rotate)).toBe("grab");
  expect(at({ x: 380, y: 160 })).toBe("move");
  t.key("escape");
  expect(at({ x: 700, y: 500 })).toBe("default");
});

test("dragging an arrow's end to another shape moves it between the shapes' boundElements", () => {
  const t = setup();
  const a1 = boxAt(t, "r", [300, 100], [460, 220]), b1 = boxAt(t, "r", [300, 400], [460, 520]);
  t.key("a"); t.drag([100, 160], [380, 160]);
  const arr = t.byType("arrow")[0];
  t.key("v"); t.ed.select([arr.id]);
  const end = resolvedPoints(t.ed.doc, arr).at(-1);
  t.drag([end[0], end[1]], [380, 460]);
  expect(t.ed.doc.get(arr.id).endBinding.elementId).toBe(b1.id);
  expect((t.ed.doc.get(a1.id).boundElements ?? []).some(x => x.id === arr.id)).toBe(false);
  expect(t.ed.doc.get(b1.id).boundElements.some(x => x.id === arr.id)).toBe(true);
});

// ── bending ──
test("dragging the ○ in the middle of a selected arrow bends it there; one undo takes it back", () => {
  const t = setup();
  t.key("a"); t.drag([100, 300], [500, 300]);
  const a = t.byType("arrow")[0];
  t.key("v"); t.ed.select([a.id]);
  const mid = t.ed.handles().find(h => h.kind === "mid");
  expect([mid.x, mid.y]).toEqual([300, 300]);
  t.ed.pointerMove({ x: mid.x, y: mid.y }, {});
  expect(t.ed.cursor()).toBe("pointer");
  t.drag([300, 300], [300, 200]);
  const bent = t.ed.doc.get(a.id);
  expect(bent.points.length).toBe(3);
  expect([bent.x + bent.points[1][0], bent.y + bent.points[1][1]]).toEqual([300, 200]);
  t.key("z", { cmd: true });
  expect(t.ed.doc.get(a.id).points.length).toBe(2);
});

test("double-clicking a bend removes it; straighten removes them all", () => {
  const t = setup();
  t.key("a"); t.click([100, 300]); t.click([250, 200]); t.click([400, 300]); t.click([550, 200]);
  t.ed.pointerDown({ x: 550, y: 200 }, { clickCount: 2 }); t.ed.pointerUp({ x: 550, y: 200 });
  const a = t.byType("arrow")[0];
  expect(a.points.length).toBe(4);
  t.key("v"); t.ed.select([a.id]);
  t.dblclick([250, 200]);
  expect(t.ed.doc.get(a.id).points.length).toBe(3);
  expect(t.ed.text).toBe(null);                              // not a label edit
  t.ed.straighten();
  expect(t.ed.doc.get(a.id).points.length).toBe(2);
});

test("making a straight arrow a curve gives it an arc; + bend bends a sharp one", () => {
  const t = setup();
  t.key("a"); t.drag([100, 300], [500, 300]);
  const a = t.byType("arrow")[0];
  t.key("v"); t.ed.select([a.id]);
  t.ed.setStyle({ elbowed: false, roundness: { type: 2 } });
  const c = t.ed.doc.get(a.id);
  expect(c.points.length).toBe(3);
  expect(Math.abs(c.y + c.points[1][1] - 300)).toBeCloseTo(80, 6);   // a fifth of 400 to the side
  t.ed.straighten(); t.ed.setStyle({ roundness: null }); t.ed.addBend();
  expect(t.ed.doc.get(a.id).points.length).toBe(3);
});

test("elbow arrows have no bend handles (their route is computed)", () => {
  const t = setup();
  t.ed.setStyle({ elbowed: true });
  t.key("a"); t.drag([100, 300], [500, 400]);
  t.key("v"); t.ed.select([t.byType("arrow")[0].id]);
  expect(t.ed.handles().some(h => h.kind === "mid")).toBe(false);
});

test("a fixedPoint on an ellipse's box (as excalidraw.com writes them) lands on the ellipse, gap off", async () => {
  const { outlineDistance } = await import("../core/geometry.js");
  const t = setup();
  const e = boxAt(t, "o", [300, 100], [500, 220]);
  t.key("a"); t.drag([100, 400], [400, 160]);
  const a = structuredClone(t.byType("arrow")[0]);
  for (const fp of [[0.2, 0], [0.5001, 0], [1, 0.9]]) {
    a.endBinding = { elementId: e.id, focus: 0, gap: 6, fixedPoint: fp };
    const end = resolvedPoints(t.ed.doc, a).at(-1), d = outlineDistance(e, { x: end[0], y: end[1] });
    expect(d).toBeGreaterThan(3); expect(d).toBeLessThan(8);   // the gap (outlineDistance is approximate on an ellipse)
  }
  // Taken as is, [0.2, 0] would leave the end floating off the ellipse:
  expect(outlineDistance(e, { x: e.x + 0.2 * e.width, y: e.y })).toBeGreaterThan(8);
  {
  }
});

test("a bend handle on a curve sits on the curve", () => {
  const t = setup();
  t.ed.setStyle({ roundness: { type: 2 } });
  t.key("a"); t.click([100, 300]); t.click([300, 150]); t.click([500, 300]);
  t.ed.pointerDown({ x: 500, y: 300 }, { clickCount: 2 }); t.ed.pointerUp({ x: 500, y: 300 });
  const a = t.byType("arrow")[0];
  t.key("v"); t.ed.select([a.id]);
  const drawn = drawnPoints(t.ed.doc, t.ed.doc.get(a.id));
  for (const h of t.ed.handles().filter(h => h.kind === "mid")) expect(drawn.some(p => Math.hypot(p[0] - h.x, p[1] - h.y) < 0.5)).toBe(true);
});

// Probed on excalidraw.com 2026-11-11 (edit a label there and it moves to its spot): these are its numbers.
test("an arrow's label sits where excalidraw.com puts it: the middle point, or the middle stretch's middle", async () => {
  const { labelAnchor } = await import("../core/geometry.js");
  const { Doc } = await import("../core/doc.js");
  const { makeElement } = await import("../core/model.js");
  const at = (x, y, points, extra = {}) => labelAnchor(new Doc({ elements: [] }), makeElement("arrow", { x, y, points, ...extra })).map(Math.round);
  expect(at(50, 50, [[0, 0], [300, 0], [300, 60]])).toEqual([350, 50]);                          // 3 points: the bend
  expect(at(50, 200, [[0, 0], [60, 0], [60, 200], [360, 200]])).toEqual([110, 300]);             // 4: the middle stretch
  expect(at(500, 200, [[0, 0], [60, 0], [60, 200], [360, 200]], { roundness: { type: 2 } })).toEqual([545, 300]);   // on the curve
  expect(at(500, 50, [[0, 0], [40, 0], [40, 40], [300, 40], [300, 100]])).toEqual([540, 90]);    // 5: the middle point
  expect(at(0, 0, [[0, 0], [200, 100]])).toEqual([100, 50]);                                      // 2: halfway, as before
});
