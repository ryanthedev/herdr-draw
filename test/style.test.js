// Files from excalidraw.com render with their own look: rounded corners, fill styles,
// arrowhead types and font families.
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { cornerRadius, roundPolygon, hatchLines, arrowheadCmds, fontClass } from "../core/style.js";
import { outlinePoints } from "../core/render.js";
import { setup, THEME } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";

afterAll(closeRaster);
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/excalidraw-com.excalidraw", import.meta.url), "utf8"));

test("corner radius follows Excalidraw (adaptive caps at 32, proportional is 25%)", () => {
  expect(cornerRadius({ roundness: { type: 3 } }, 100)).toBe(25);
  expect(cornerRadius({ roundness: { type: 3 } }, 400)).toBe(32);
  expect(cornerRadius({ roundness: { type: 2 } }, 400)).toBe(100);
  expect(cornerRadius({ roundness: null }, 400)).toBe(0);
  const sq = roundPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], 20);
  expect(sq.some(([x, y]) => x === 0 && y === 0)).toBe(false);          // the corner is cut
  expect(sq.some(([x, y]) => Math.abs(x - 20) < 1e-9 && y === 0)).toBe(true);
});

test("hatch lines stay inside the shape and are evenly spaced", () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const lines = hatchLines(sq, 0, 10);
  expect(lines.length).toBe(10);
  for (const [a, b] of lines) { expect(a[0]).toBeCloseTo(0, 6); expect(b[0]).toBeCloseTo(100, 6); }
  for (const [a, b] of hatchLines(sq, -0.7, 8)) for (const p of [a, b]) { expect(p[0]).toBeGreaterThan(-1e-6); expect(p[0]).toBeLessThan(100 + 1e-6); }
});

test("arrowhead types: filled ones fill, outlines and bars stroke", () => {
  const f = t => arrowheadCmds(t, [0, 0], [100, 0], 18);
  expect(f("triangle").fills.length).toBeGreaterThan(0);
  expect(f("triangle_outline").fills.length).toBe(0);
  expect(f("dot").fills.length).toBeGreaterThan(0);
  expect(f("bar").strokes.length).toBe(2);
  expect(f("arrow").strokes.length).toBe(4);
  expect(fontClass(1)).toBe("hand"); expect(fontClass(5)).toBe("hand"); expect(fontClass(3)).toBe("mono"); expect(fontClass(2)).toBe("sans");
});

test("an excalidraw.com file renders with its styles", () => {
  const t = setup({ scene: fixture() });
  const items = t.ed.displayList(THEME);
  const byId = id => items.filter(i => i.id === id);
  // Rounded rectangle: its outline has many points, not 5.
  expect(outlinePoints(t.ed.doc.get("r1")).length).toBeGreaterThan(20);
  // Hachure: fill drawn as strokes in the fill color, not one solid fill.
  const r1 = byId("r1");
  expect(r1.some(i => i.stroke === "#a5d8ff")).toBe(true);
  expect(r1.some(i => i.fill === "#a5d8ff")).toBe(false);
  // Cross-hatch draws about twice the lines of hachure on the same shape.
  const hatchCount = items.find(i => i.id === "e1" && i.stroke === "#b2f2bb").cmds.length;
  expect(hatchCount).toBeGreaterThan(20);
  // Arrow: triangle at the end and a dot at the start, both filled in the stroke color.
  const fills = byId("a1").filter(i => i.fill);
  expect(fills.length).toBe(1);
  expect(fills[0].cmds.filter(c => c[0] === "M").length).toBe(2);
  // Rounded multi-point line is smooth (quadratic segments), with bar + diamond outline heads.
  expect(byId("l1")[0].cmds.some(c => c[0] === "Q")).toBe(true);
  // Fonts: Excalifont label → hand; Cascadia text → mono.
  expect(items.find(i => i.id === "t1").font).toBe("hand");
  expect(items.find(i => i.id === "t1").color).toBe(THEME.fg);   // on hachure the background shows through: theme ink, not dark
  expect(items.find(i => i.id === "m1").font).toBe("mono");
});

test("new shapes take fill style, edges and font from the panel's choices", () => {
  const t = setup();
  t.ed.setStyle({ fillStyle: "hachure", roundness: { type: 3 }, backgroundColor: "#ffec99", fontFamily: 3 });
  t.key("r"); t.drag([100, 100], [300, 200]);
  const [r] = t.byType("rectangle");
  expect([r.fillStyle, r.roundness?.type, r.backgroundColor]).toEqual(["hachure", 3, "#ffec99"]);
  t.dblclick([200, 150]); t.type("mono label");
  expect(t.byType("text")[0].fontFamily).toBe(3);
  t.click([200, 100]);
  t.ed.setStyle({ fontFamily: 5 });
  expect(t.byType("text")[0].fontFamily).toBe(5);       // restyling a shape restyles its label
});

test("snapshot: the excalidraw.com fixture", async () => {
  const t = setup({ scene: fixture(), w: 700, h: 360 });
  const svg = await t.shot("excalidraw-fidelity");
  expect(svg).toContain("Cascadia");
  expect(svg).toContain("Excalifont");
});
