import { test, expect, afterAll } from "bun:test";
import { setup } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";
import { bounds, hitTest, resolvedPoints, centerOf } from "../core/geometry.js";

afterAll(closeRaster);
const deg = a => Math.round(a * 180 / Math.PI);

test("dragging the rotate handle turns a shape about its center; shift snaps to 15°", () => {
  const t = setup();
  t.key("r"); t.drag([200, 200], [400, 300]);          // center (300, 250)
  const rot = t.ed.handles().find(h => h.kind === "rotate");
  expect(rot.x).toBeCloseTo(300, 0);                    // above the top middle
  // Drag the handle round to the right of the center: a quarter turn.
  t.drag([rot.x, rot.y], [440, 252], { shift: true });
  const [r] = t.byType("rectangle");
  expect(deg(r.angle)).toBe(90);
  expect(centerOf(r).x).toBeCloseTo(300, 5);
  expect(centerOf(r).y).toBeCloseTo(250, 5);
  // Its drawn bounds are now tall, not wide.
  const b = bounds(r);
  expect(b.w).toBeCloseTo(100, 0); expect(b.h).toBeCloseTo(200, 0);
});

test("hit testing follows rotation", () => {
  const t = setup();
  t.key("r"); t.drag([200, 240], [400, 260]);          // a thin bar, center (300, 250)
  t.ed.rotateBy(90);                                    // now vertical
  t.key("escape");
  expect(hitTest(t.ed.doc, { x: 300, y: 160 })).toBeTruthy();   // on the vertical bar
  expect(hitTest(t.ed.doc, { x: 390, y: 250 })).toBeFalsy();    // where the old ends were
});

test("resizing a rotated shape keeps the opposite corner fixed", () => {
  const t = setup();
  t.key("r"); t.drag([200, 200], [400, 300]);
  t.ed.rotateBy(30);
  const nwBefore = t.ed.handles().find(h => h.dir === "nw");
  const se = t.ed.handles().find(h => h.dir === "se");
  t.drag([se.x, se.y], [se.x + 40, se.y + 40]);
  const [r] = t.byType("rectangle");
  expect(deg(r.angle)).toBe(30);
  expect(r.width).toBeGreaterThan(200);
  const nwAfter = t.ed.handles().find(h => h.dir === "nw");
  expect(nwAfter.x).toBeCloseTo(nwBefore.x, 1);
  expect(nwAfter.y).toBeCloseTo(nwBefore.y, 1);
});

test("an arrow bound to a rotated shape meets its rotated outline", () => {
  const t = setup();
  t.key("d"); t.drag([100, 100], [300, 200]);           // diamond, center (200, 150)
  t.key("r"); t.drag([500, 120], [600, 180]);
  t.key("a"); t.drag([200, 150], [550, 150]);
  t.key("escape");
  t.click([200, 100]);                                  // the diamond's top point
  t.ed.rotateBy(90);
  const arrow = t.byType("arrow")[0];
  const p = resolvedPoints(t.ed.doc, arrow)[0];
  // Turned 90°, the diamond's right point is 50 from center (was 100): the arrow starts there.
  expect(p[0]).toBeCloseTo(200 + 50 + 6, 0);
});

test("rotating a group turns it as one; lines get their points turned", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]);
  t.key("l"); t.drag([300, 130], [400, 130]);
  t.key("a", { cmd: true });
  t.ed.rotateBy(180);
  const [r] = t.byType("rectangle"), [l] = t.byType("line");
  expect(deg(r.angle)).toBe(180);
  expect(centerOf(r).x).toBeCloseTo(350, 5);            // swapped sides about the group center (250)
  expect(l.angle || 0).toBe(0);                          // baked into points
  expect(Math.min(l.x, l.x + l.points[1][0])).toBeCloseTo(100, 5);
});

test("labels follow their shape's angle; < and > keys rotate by 15°; reset", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [260, 180]); t.dblclick([180, 140]); t.type("turn me");
  t.click([180, 100]);
  t.key(">"); t.key(">");
  const [r] = t.byType("rectangle"), [label] = t.byType("text");
  expect(deg(r.angle)).toBe(30);
  expect(label.angle).toBeCloseTo(r.angle, 9);
  t.key("<");
  expect(deg(t.byType("rectangle")[0].angle)).toBe(15);
  t.ed.resetRotation();
  expect(t.byType("rectangle")[0].angle).toBe(0);
});

test("snapshot: rotated shapes, label, bound arrow", async () => {
  const t = setup();
  t.key("r"); t.drag([80, 120], [260, 200]); t.dblclick([170, 160]); t.type("tilted box");
  t.click([170, 120]); t.ed.rotateBy(-12);
  t.key("d"); t.drag([340, 80], [520, 240]); t.key("escape"); t.click([430, 80]); t.ed.rotateBy(20);
  t.key("o"); t.drag([600, 100], [780, 200]); t.key("b");
  t.key("a"); t.drag([170, 160], [690, 150]);
  t.key("escape"); t.click([430, 200]);                 // inside the turned diamond: shows its turned frame
  expect(t.ed.sel.size).toBe(1);
  const svg = await t.shot("rotation");
  expect(svg).toContain('transform="rotate(');
});
