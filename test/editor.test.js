import { test, expect, afterAll } from "bun:test";
import { setup } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";
import { bbox } from "../core/geometry.js";
import { Doc } from "../core/doc.js";
import { animState } from "../core/anim.js";

afterAll(closeRaster);

test("drag with the rectangle tool draws a rectangle, then returns to select", () => {
  const t = setup();
  t.key("r");
  t.drag([100, 100], [260, 180]);
  const [r] = t.byType("rectangle");
  expect(r).toBeTruthy();
  expect([r.x, r.y, r.width, r.height]).toEqual([100, 100, 160, 80]);
  expect(t.ed.tool).toBe("select");
  expect(t.ed.sel.has(r.id)).toBe(true);
});

test("dragging up-left still gives a positive box", () => {
  const t = setup();
  t.key("o"); t.drag([300, 300], [200, 250]);
  const [e] = t.byType("ellipse");
  expect([e.x, e.y, e.width, e.height]).toEqual([200, 250, 100, 50]);
});

test("a click with a shape tool makes a default-size shape", () => {
  const t = setup();
  t.key("d"); t.click([400, 300]);
  const [d] = t.byType("diamond");
  expect([d.width, d.height]).toEqual([140, 80]);
});

test("arrow drawn between two shapes binds both ends and follows a move", () => {
  const t = setup();
  t.key("r"); t.drag([50, 50], [150, 130]);
  t.key("r"); t.drag([400, 50], [500, 130]);
  t.key("a"); t.drag([100, 90], [450, 90]);
  const [a] = t.byType("arrow");
  const [r1, r2] = t.byType("rectangle");
  expect(a.startBinding.elementId).toBe(r1.id);
  expect(a.endBinding.elementId).toBe(r2.id);
  // The arrow's baked geometry ends at the outlines, not the centers.
  expect(a.x).toBeCloseTo(156, 0);
  // Move the second box down; the arrow follows.
  t.key("escape");
  t.drag([500, 90], [500, 290]);
  const a2 = t.ed.doc.get(a.id);
  const end = [a2.x + a2.points[1][0], a2.y + a2.points[1][1]];
  expect(end[1]).toBeGreaterThan(200);
});

test("click-click-double-click makes a polyline", () => {
  const t = setup();
  t.key("l");
  t.click([100, 100]); t.ed.pointerMove({ x: 200, y: 100 });
  t.click([200, 100]); t.ed.pointerMove({ x: 200, y: 200 });
  t.dblclick([200, 200]);
  const [l] = t.byType("line");
  expect(l.points.length).toBe(3);
  expect(t.ed.g).toBe(null);
});

test("pen draws a freehand stroke with many points", () => {
  const t = setup();
  t.key("p"); t.drag([100, 100], [300, 200], {}, 30);
  const [f] = t.byType("freedraw");
  expect(f.points.length).toBeGreaterThan(20);
  expect(t.ed.tool).toBe("freedraw");   // the pen stays on
});

test("select, move with snapping to another shape's edge", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]);
  t.key("r"); t.drag([300, 300], [400, 360]);
  t.key("escape");
  // Move the second so its left edge lands 3px off the first's left edge: snaps.
  t.drag([350, 300], [153, 400]);
  const r2 = t.byType("rectangle")[1];
  expect(r2.x).toBe(100);
});

test("an empty box is selected and dragged from its middle, selected or not", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [300, 250]);          // drawn, so selected
  t.drag([200, 175], [260, 215]);                        // press in the empty middle
  expect(t.byType("rectangle")[0].x).toBe(160);
  t.key("escape");
  t.click([260, 215]);                                   // unselected: a click inside selects it
  expect(t.ed.sel.size).toBe(1);
  t.key("escape");
  t.drag([260, 215], [300, 215]);                        // and a drag inside moves it
  expect(t.byType("rectangle")[0].x).toBe(200);
});

test("inside nested empty boxes, the smaller one wins; shapes under a big box stay reachable", () => {
  const t = setup();
  t.key("r"); t.drag([150, 150], [250, 230]);            // small, drawn first (underneath)
  t.key("r"); t.drag([50, 50], [500, 400]);              // big, drawn on top
  const [small, big] = t.byType("rectangle");
  t.key("escape");
  t.click([200, 190]); expect([...t.ed.sel]).toEqual([small.id]);
  t.key("escape");
  t.click([400, 300]); expect([...t.ed.sel]).toEqual([big.id]);
});

test("frames stay click-through inside, so a marquee can start in them", () => {
  const t = setup();
  t.key("f"); t.drag([50, 50], [500, 400]);
  t.key("escape");
  t.click([250, 250]);
  expect(t.ed.sel.size).toBe(0);
});

test("marquee selects enclosed elements; align left; distribute", () => {
  const t = setup();
  for (const [x, y] of [[100, 50], [180, 150], [140, 300]]) { t.key("r"); t.drag([x, y], [x + 60, y + 40]); }
  t.key("escape");
  t.drag([50, 20], [400, 400]);
  expect(t.ed.sel.size).toBe(3);
  t.key("a", { alt: true });
  expect(t.byType("rectangle").map(r => r.x)).toEqual([100, 100, 100]);
  t.key("v", { shift: true });
  const ys = t.byType("rectangle").map(r => r.y).sort((a, b) => a - b);
  expect(ys[1] - ys[0]).toBeCloseTo(ys[2] - ys[1], 5);
});

test("resize from the se handle, shift keeps proportions", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 150]);
  // se handle sits 8px outside the box corner.
  t.drag([208, 158], [308, 158], { shift: true });
  const [r] = t.byType("rectangle");
  expect(r.width).toBeCloseTo(200, 0);
  expect(r.height).toBeCloseTo(100, 0);
});

test("double-click a shape to label it; the label moves with it", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [240, 180]);
  t.dblclick([170, 140]);
  expect(t.ed.text).toBeTruthy();
  t.type("Hello");
  const [label] = t.byType("text");
  expect(label.text).toBe("Hello");
  expect(label.containerId).toBe(t.byType("rectangle")[0].id);
  t.drag([100, 140], [150, 140]);
  expect(t.ed.doc.get(label.id).x).toBeGreaterThan(label.x);
});

test("undo and redo a whole gesture, and a delete", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  t.drag([150, 100], [350, 100]);
  expect(t.byType("rectangle")[0].x).toBe(300);
  t.key("z", { cmd: true });
  expect(t.byType("rectangle")[0].x).toBe(100);
  t.key("z", { cmd: true, shift: true });
  expect(t.byType("rectangle")[0].x).toBe(300);
  t.key("backspace");
  expect(t.byType("rectangle").length).toBe(0);
  t.key("z", { cmd: true });
  expect(t.byType("rectangle").length).toBe(1);
  t.key("z", { cmd: true }); t.key("z", { cmd: true });
  expect(t.byType("rectangle").length).toBe(0);   // undid the creation too
});

test("eraser drag deletes what it crosses", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  t.key("a"); t.drag([300, 50], [300, 250]);
  t.key("e"); t.drag([80, 150], [400, 150], {}, 30);
  expect(t.live().length).toBe(0);
});

test("copy / paste uses Excalidraw's clipboard format and new ids", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  const text = t.ed.copy();
  expect(JSON.parse(text).type).toBe("excalidraw/clipboard");
  t.ed.paste(text, { x: 500, y: 300 });
  const rs = t.byType("rectangle");
  expect(rs.length).toBe(2);
  expect(rs[0].id).not.toBe(rs[1].id);
});

test("group: clicking one member selects the group; ungroup", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [150, 150]);
  t.key("r"); t.drag([200, 100], [250, 150]);
  t.key("a", { cmd: true }); t.key("g", { cmd: true });
  t.key("escape"); t.click([100, 125]);
  expect(t.ed.sel.size).toBe(2);
  t.key("g", { cmd: true, shift: true }); t.key("escape"); t.click([100, 125]);
  expect(t.ed.sel.size).toBe(1);
});

test("layers: new elements go to the active layer; hidden layers can't be hit; reorder changes paint order", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  const top = t.ed.addLayer("Notes");
  t.key("b");   // fill for the next one... applies to style since nothing editable selected? (selection is empty after addLayer? no)
  t.key("escape");
  t.key("r"); t.drag([150, 150], [250, 250]);
  const [a, b] = t.ed.doc.live();
  expect(b.customData.layer).toBe(top);
  t.ed.moveLayer(top, -1);
  expect(t.ed.doc.live()[0].id).toBe(b.id);   // now painted first (bottom)
  t.ed.updateLayer(top, { visible: false });
  t.key("escape");
  t.click([240, 240]);
  expect(t.ed.sel.size).toBe(0);
});

test("ops round-trip: replaying the op stream rebuilds the same board", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  t.key("a"); t.drag([150, 150], [400, 300]);
  t.dblclick([150, 150]); t.type("x");
  t.key("z", { cmd: true });
  const replica = new Doc({ elements: [] });
  for (const op of t.ops) replica.apply(op);
  const strip = d => d.live().map(e => [e.id, e.version, e.x, e.y]);
  expect(strip(replica)).toEqual(strip(t.ed.doc));
});

test("animation presets stagger and interpolate", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  t.key("r"); t.drag([300, 100], [400, 200]);
  t.key("a", { cmd: true });
  t.ed.animate("rise", { duration: 500, stagger: 200 });
  const [a, b] = t.byType("rectangle");
  expect(a.customData.anim.start).toBe(0);
  expect(b.customData.anim.start).toBe(200);
  expect(animState(a, 0).opacity).toBe(0);
  expect(animState(a, 500).opacity).toBe(1);
  expect(animState(b, 450).dy).toBeGreaterThan(0);
  t.key("space", { shift: true });
  expect(t.ed.needsTick()).toBe(true);
});

test("snapshot: a small diagram renders (written to test/out)", async () => {
  const t = setup();
  t.key("r"); t.drag([60, 60], [220, 140]); t.dblclick([140, 100]); t.type("Browser");
  t.key("d"); t.drag([320, 40], [480, 160]); t.dblclick([400, 100]); t.type("Auth?");
  t.key("o"); t.drag([580, 60], [740, 140]); t.key("b"); t.dblclick([660, 100]); t.type("API");
  t.key("a"); t.drag([140, 100], [400, 100]);
  t.key("a"); t.drag([400, 100], [660, 100]);
  t.key("p"); t.drag([100, 300], [300, 380], {}, 25);
  t.key("t"); t.click([400, 320]); t.type("hand-drawn, headless");
  t.key("escape"); t.drag([20, 20], [800, 200]);   // marquee: select the row
  const svg = await t.shot("diagram");
  expect(svg).toContain("Browser");
  expect(t.ed.sel.size).toBeGreaterThanOrEqual(5);
});
