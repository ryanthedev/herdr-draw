import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { elbowRoute, facingSide, simplify } from "../core/elbow.js";
import { resolvedPoints, bbox, alongPath } from "../core/geometry.js";
import { Editor } from "../core/editor.js";
import { setup, THEME } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";

afterAll(closeRaster);
const ROOT = new URL("..", import.meta.url).pathname;

// Every segment is horizontal or vertical.
const orthogonal = pts => pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 1e-6 || Math.abs(p.y - pts[i - 1].y) < 1e-6);
// No segment runs through a box's inside (touching the outline is fine).
const avoids = (pts, b) => pts.every((p, i) => {
  if (!i) return true;
  const a = pts[i - 1], minx = Math.min(a.x, p.x), maxx = Math.max(a.x, p.x), miny = Math.min(a.y, p.y), maxy = Math.max(a.y, p.y);
  return maxx <= b.x + 0.5 || minx >= b.x + b.w - 0.5 || maxy <= b.y + 0.5 || miny >= b.y + b.h - 0.5;
});
const A = { x: 0, y: 0, w: 100, h: 60 };

test("side by side: straight out the right side and into the left side", () => {
  const B = { x: 300, y: 0, w: 100, h: 60 };
  const r = elbowRoute({ box: A }, { box: B });
  expect(r.sides).toEqual(["right", "left"]);
  expect(r.points.length).toBe(2);                        // aligned: no bends at all
  expect(r.points[0]).toEqual({ x: 106, y: 30 });
  expect(r.points[1]).toEqual({ x: 294, y: 30 });
});

test("offset diagonally: a Z with two bends halfway", () => {
  const B = { x: 300, y: 200, w: 100, h: 60 };
  const r = elbowRoute({ box: A }, { box: B });
  expect(orthogonal(r.points)).toBe(true);
  expect(r.points.length).toBe(4);
  // The middle run joins the two stubs, whichever way the Z faces.
  const [p1, p2] = [r.points[1], r.points[2]];
  expect(Math.abs(p1.x - p2.x) < 1e-6 || Math.abs(p1.y - p2.y) < 1e-6).toBe(true);
  for (const b of [A, B]) expect(avoids(r.points, b)).toBe(true);
});

test("stacked: out the bottom, into the top", () => {
  const B = { x: 40, y: 300, w: 100, h: 60 };
  const r = elbowRoute({ box: A }, { box: B });
  expect(r.sides).toEqual(["bottom", "top"]);
  expect(orthogonal(r.points)).toBe(true);
  // The last segment comes straight down into the target.
  const [p, q] = r.points.slice(-2);
  expect(p.x).toBeCloseTo(q.x, 6); expect(q.y).toBeGreaterThan(p.y);
});

test("sides facing away go around both shapes, never through them", () => {
  const B = { x: 300, y: 10, w: 100, h: 60 };
  const r = elbowRoute({ box: A, side: "left" }, { box: B, side: "right" });
  expect(orthogonal(r.points)).toBe(true);
  for (const b of [A, B]) expect(avoids(r.points, b)).toBe(true);
  const r2 = elbowRoute({ box: A, side: "right" }, { box: B, side: "bottom" });   // perpendicular: one bend
  expect(orthogonal(r2.points)).toBe(true);
});

test("a shape in the way: the route goes around it", () => {
  const B = { x: 600, y: 0, w: 100, h: 60 }, W = { x: 300, y: -20, w: 100, h: 100 };
  const plain = elbowRoute({ box: A }, { box: B });
  expect(avoids(plain.points, W)).toBe(false);            // straight across would cut through W
  const r = elbowRoute({ box: A }, { box: B }, 6, [W]);
  expect(orthogonal(r.points)).toBe(true);
  for (const b of [A, B, W]) expect(avoids(r.points, b)).toBe(true);
});

test("helpers: facing side, simplify", () => {
  expect(facingSide(A, { x: 500, y: 40 })).toBe("right");
  expect(facingSide(A, { x: 50, y: -300 })).toBe("top");
  expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 9 }])).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 9 }]);
  expect(alongPath([[0, 0], [10, 0], [10, 10]], 0.5)).toEqual([10, 0]);
});

test("drawing with the elbow arrow type binds, routes and follows a moved shape", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]);
  t.key("r"); t.drag([400, 300], [500, 360]);
  t.ed.setStyle({ elbowed: true });
  t.key("a"); t.drag([150, 130], [450, 330]);
  const [a] = t.byType("arrow");
  expect(a.elbowed).toBe(true);
  expect(a.startBinding && a.endBinding).toBeTruthy();
  const pts = () => resolvedPoints(t.ed.doc, t.ed.doc.get(a.id)).map(([x, y]) => ({ x, y }));
  expect(orthogonal(pts())).toBe(true);
  expect(t.ed.doc.get(a.id).points.length).toBeGreaterThan(2);   // the route is baked into the file
  // Move the target far up-right: still orthogonal, still clear of both boxes.
  t.key("escape"); t.drag([450, 300], [650, 0]);
  const [r1, r2] = t.byType("rectangle");
  expect(orthogonal(pts())).toBe(true);
  for (const r of [r1, r2]) expect(avoids(pts(), bbox(r))).toBe(true);
});

test("an elbow arrow has handles only at its two ends; dragging the end off unbinds it", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]);
  t.key("r"); t.drag([400, 300], [500, 360]);
  t.ed.setStyle({ elbowed: true });
  t.key("a"); t.drag([150, 130], [450, 330]);
  const hs = t.ed.handles();
  expect(hs.length).toBe(2);
  t.drag([hs[1].x, hs[1].y], [700, 500]);
  const a = t.byType("arrow")[0];
  expect(a.endBinding).toBe(null);
  const end = resolvedPoints(t.ed.doc, a).at(-1);
  expect(end[0]).toBeCloseTo(700, 0); expect(end[1]).toBeCloseTo(500, 0);
});

test("labels sit halfway along the path; switching to sharp keeps the bends as points", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]);
  t.key("r"); t.drag([400, 300], [500, 360]);
  t.ed.setStyle({ elbowed: true });
  t.key("a"); t.drag([150, 130], [450, 330]);
  const a = t.byType("arrow")[0];
  t.dblclick(Object.values(t.ed.toScreen({ x: alongPath(resolvedPoints(t.ed.doc, a))[0], y: alongPath(resolvedPoints(t.ed.doc, a))[1] })));
  t.type("async");
  const label = t.ed.displayList(THEME).find(i => i.t === "text" && i.text === "async");
  const mid = alongPath(resolvedPoints(t.ed.doc, a));
  expect(label.box.x + label.box.w / 2).toBeCloseTo(mid[0], 0);
  t.click(Object.values(t.ed.toScreen({ x: mid[0], y: mid[1] })));
  const n = resolvedPoints(t.ed.doc, a).length;
  t.ed.setStyle({ elbowed: false });
  const b = t.byType("arrow")[0];
  expect(b.elbowed).toBe(false);
  expect(b.points.length).toBe(n);
});

test("drawh arrow --elbow and mermaid --elbow: routed, orthogonal arrows the core reads", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  const run = (args, input) => { const r = Bun.spawnSync([`${ROOT}cli/drawh`, ...args], { stdin: input ? new TextEncoder().encode(input) : undefined }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString(); };
  run(["add", f, "rect", "--at", "0,0", "--label", "A"]);
  run(["add", f, "rect", "--at", "300,200", "--label", "B"]);
  run(["arrow", f, "A", "B", "--elbow"]);
  run(["mermaid", f, "--elbow"], "graph TD\n  X[Root] --> Y[Left] & Z[Right]");
  const ed = new Editor({ scene: JSON.parse(readFileSync(f, "utf8")) });
  const arrows = ed.doc.live().filter(e => e.type === "arrow");
  expect(arrows.length).toBe(3);
  for (const a of arrows) {
    expect(a.elbowed).toBe(true);
    expect(orthogonal(resolvedPoints(ed.doc, a).map(([x, y]) => ({ x, y })))).toBe(true);
  }
  // Mermaid's baked points are already the route.
  const m = arrows.find(a => a.points.length > 2);
  expect(m).toBeTruthy();
});

test("snapshot: elbow arrows", async () => {
  const t = setup({ w: 900, h: 560 });
  t.ed.setStyle({ elbowed: true });
  t.ed.paste(`graph LR
    API[API] --> Q[Queue]
    API --> C[(Cache)]
    Q --> W[Worker] --> DB[(Postgres)]
    C --> DB`, { x: 450, y: 280 });
  t.key("escape");
  const svg = await t.shot("elbow");
  expect(svg).toContain("Worker");
  // No arrow cuts through a shape it isn't attached to.
  for (const a of t.byType("arrow")) {
    const pts = resolvedPoints(t.ed.doc, a).map(([x, y]) => ({ x, y }));
    for (const r of t.live().filter(e => e.type === "rectangle" && e.id !== a.startBinding?.elementId && e.id !== a.endBinding?.elementId)) expect(avoids(pts, bbox(r))).toBe(true);
  }
});
