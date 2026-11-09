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
