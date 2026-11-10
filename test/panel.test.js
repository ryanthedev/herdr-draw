// The side panel's model (core/panel.js) and the color picker's math (core/color.js).
import { test, expect } from "bun:test";
import { SECTIONS, WIDTH, CANVAS_MIN, PALETTE_MAX, defaultPanel, parsePanel, serializePanel, applyPanel, panelLayout, panelSections, dragWidth, moveOnto } from "../core/panel.js";
import { normalizeColor, hexToRgb, rgbToHex, hexToHsv, hsvToHex, pushRecentColor, inkOn, RECENT_COLORS_MAX } from "../core/color.js";

const ids = SECTIONS.map(s => s.id);

test("anything unreadable is the default; a round trip keeps everything", () => {
  for (const bad of [undefined, "", "{", "[]", "null", "42"]) expect(parsePanel(bad)).toEqual(defaultPanel());
  let s = defaultPanel();
  s = applyPanel(s, { type: "width", width: 300 });
  s = applyPanel(s, { type: "move", id: "library", to: 0 });
  s = applyPanel(s, { type: "fold", id: "layers" });
  s = applyPanel(s, { type: "addColor", kind: "fill", color: "#ABC" });
  expect(parsePanel(serializePanel(s))).toEqual(s);
});

test("a file from another version: unknown sections dropped, new ones appended, junk cleaned", () => {
  const s = parsePanel(JSON.stringify({ width: 9999, order: ["layers", "gone", "layers", "properties"], folded: ["x", "frames"], hidden: ["properties", "animate"],
    mode: "grid", tab: "animate", palette: { stroke: ["#f00", "nope", "#ff0000"], fill: "x" }, recent: ["#00F", 3] }));
  expect(s.width).toBe(WIDTH.max);
  expect(s.order.slice(0, 2)).toEqual(["layers", "properties"]);
  expect([...s.order].sort()).toEqual([...ids].sort());
  expect(s.folded).toEqual(["frames"]);
  expect(s.hidden).toEqual(["animate"]);          // properties can't be hidden
  expect(s.mode).toBe("stack");
  expect(s.tab).toBe("layers");                   // the hidden tab falls back to the first shown section
  expect(s.palette).toEqual({ stroke: ["#ff0000"], fill: [] });
  expect(s.recent).toEqual(["#0000ff"]);
});

test("ops: width clamps, fold toggles, move reorders, a no-op returns the same object", () => {
  const d = defaultPanel();
  expect(applyPanel(d, { type: "width", width: 10 }).width).toBe(WIDTH.min);
  expect(applyPanel(d, { type: "width", width: d.width })).toBe(d);
  const f = applyPanel(d, { type: "fold", id: "layers" });
  expect(f.folded).toEqual(["layers"]);
  expect(applyPanel(f, { type: "fold", id: "layers" }).folded).toEqual([]);
  expect(applyPanel(d, { type: "foldAll", folded: true }).folded.length).toBe(ids.length);
  expect(applyPanel(d, { type: "move", id: "properties", to: 99 }).order.at(-1)).toBe("properties");
  expect(applyPanel(d, { type: "move", id: "library", to: 1 }).order.slice(0, 2)).toEqual(["properties", "library"]);
  expect(applyPanel(d, { type: "move", id: "nope", to: 0 })).toBe(d);
  expect(applyPanel(d, { type: "hide", id: "properties" })).toBe(d);
  expect(applyPanel(d, { type: "open" }).open).toBe(false);
  expect(applyPanel(d, { type: "bogus" })).toBe(d);
});

test("tabs: picking a tab switches to tabs mode; hiding the active tab moves it on", () => {
  let s = applyPanel(defaultPanel(), { type: "tab", id: "layers" });
  expect(s.mode).toBe("tabs");
  expect(panelSections(s).filter(x => x.active).map(x => x.id)).toEqual(["layers"]);
  s = applyPanel(s, { type: "hide", id: "layers" });
  expect(s.tab).toBe("properties");
  expect(panelSections(s).map(x => x.id)).not.toContain("layers");
  // A tab with nothing to show right now (Arrange, no selection) falls back to the first one that has.
  s = applyPanel(s, { type: "tab", id: "arrange" });
  expect(panelSections(s, id => id !== "arrange").find(x => x.active).id).toBe("properties");
});

test("stack mode: every section drawn, folded ones marked; folds don't apply as tabs", () => {
  let s = applyPanel(defaultPanel(), { type: "fold", id: "library" });
  const rows = panelSections(s, id => id !== "frames");
  expect(rows.map(r => r.id)).toEqual(ids.filter(id => id !== "frames"));
  expect(rows.every(r => r.active)).toBe(true);
  expect(rows.find(r => r.id === "library").folded).toBe(true);
  s = applyPanel(s, { type: "mode", mode: "tabs" });
  expect(panelSections(s).some(r => r.folded)).toBe(false);
});

test("layout: the board keeps its minimum; the panel narrows, then hides", () => {
  const s = applyPanel(defaultPanel(), { type: "width", width: 400 });
  expect(panelLayout(s, 1200)).toEqual({ show: true, width: 400 });
  expect(panelLayout(s, CANVAS_MIN + 300)).toEqual({ show: true, width: 300 });
  expect(panelLayout(s, CANVAS_MIN + WIDTH.min - 1).show).toBe(false);
  expect(panelLayout(applyPanel(s, { type: "open", open: false }), 1200).show).toBe(false);
});

test("dragging the left edge widens to the left; dragging a title onto another swaps places", () => {
  expect(dragWidth(232, 500, 450)).toBe(282);
  expect(dragWidth(232, 500, 900)).toBe(WIDTH.min);
  const s = defaultPanel();   // properties, arrange, frames, animate, layers, library
  expect(moveOnto(s, "properties", "frames").order.slice(0, 3)).toEqual(["arrange", "frames", "properties"]);   // down: below it
  expect(moveOnto(s, "library", "frames").order.slice(0, 4)).toEqual(["properties", "arrange", "library", "frames"]);   // up: above it
  // Dragging down a list one row at a time walks the section down.
  let r = s; for (const over of ["arrange", "frames", "animate"]) r = moveOnto(r, "properties", over);
  expect(r.order).toEqual(["arrange", "frames", "animate", "properties", "layers", "library"]);
  expect(moveOnto(s, "layers", "layers")).toBe(s);
  expect(moveOnto(s, "layers", "nope")).toBe(s);
});

test("palette: colors normalized, no duplicates, capped; reset keeps colors", () => {
  let s = defaultPanel();
  s = applyPanel(s, { type: "addColor", kind: "stroke", color: "F00" });
  expect(applyPanel(s, { type: "addColor", kind: "stroke", color: "#ff0000" })).toBe(s);
  expect(applyPanel(s, { type: "addColor", kind: "stroke", color: "red" })).toBe(s);
  for (let i = 0; i < PALETTE_MAX + 5; i++) s = applyPanel(s, { type: "addColor", kind: "fill", color: rgbToHex({ r: i, g: 0, b: 0 }) });
  expect(s.palette.fill.length).toBe(PALETTE_MAX);
  s = applyPanel(s, { type: "removeColor", kind: "stroke", color: "#F00" });
  expect(s.palette.stroke).toEqual([]);
  s = applyPanel(applyPanel(s, { type: "used", color: "#123456" }), { type: "width", width: 400 });
  const r = applyPanel(s, { type: "reset" });
  expect(r.width).toBe(WIDTH.default);
  expect(r.recent).toEqual(["#123456"]);
  expect(r.palette.fill.length).toBe(PALETTE_MAX);
});

test("colors: parsing what people type", () => {
  expect(normalizeColor("#ABC")).toBe("#aabbcc");
  expect(normalizeColor(" 1e1e1e ")).toBe("#1e1e1e");
  expect(normalizeColor("Transparent")).toBe("transparent");
  for (const bad of ["", "#12", "#12345", "red", "#ggg", null, undefined]) expect(normalizeColor(bad)).toBeNull();
});

test("colors: hex ↔ RGB ↔ HSV round trips", () => {
  expect(hexToRgb("#1971c2")).toEqual({ r: 25, g: 113, b: 194 });
  expect(rgbToHex({ r: 300, g: -4, b: 127.6 })).toBe("#ff0080");
  expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
  expect(hexToHsv("#00ff00").h).toBe(120);
  expect(hexToHsv("#808080").s).toBe(0);
  expect(hexToRgb("transparent")).toBeNull();
  for (const c of ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599", "#ffc9c9", "#ffffff", "#000000"])
    expect(hsvToHex(hexToHsv(c))).toBe(c);
  expect(hsvToHex({ h: 720, s: 2, v: -1 })).toBe("#000000");   // out of range clamps
});

test("colors: recent list and ink", () => {
  let r = [];
  for (let i = 0; i < 12; i++) r = pushRecentColor(r, rgbToHex({ r: i, g: i, b: i }));
  expect(r.length).toBe(RECENT_COLORS_MAX);
  expect(r[0]).toBe("#0b0b0b");
  expect(pushRecentColor(r, "#0A0A0A")[0]).toBe("#0a0a0a");
  expect(pushRecentColor(r, "#0a0a0a").length).toBe(RECENT_COLORS_MAX);
  expect(pushRecentColor(["#fff", "zzz"], "nope")).toEqual(["#ffffff"]);
  expect(inkOn("#ffec99")).toBe("#000000");
  expect(inkOn("#1971c2")).toBe("#ffffff");
});

test("picker grid: a gray column plus one per hue, light to dark, all distinct colors", async () => {
  const { swatchGrid, hexToHsv } = await import("../core/color.js");
  const g = swatchGrid(12, 5);
  expect(g.length).toBe(5);
  expect(g.every(r => r.length === 13)).toBe(true);
  expect(new Set(g.flat()).size).toBe(65);
  for (let c = 0; c < 13; c++) for (let r = 1; r < 5; r++) {
    const a = hexToHsv(g[r - 1][c]), b = hexToHsv(g[r][c]);
    expect(a.v * (1 - a.s / 2)).toBeGreaterThanOrEqual(b.v * (1 - b.s / 2) - 1e-9);   // never lighter going down
  }
  expect(hexToHsv(g[0][0]).s).toBe(0);
});

test("color row: saved colors after the fixed ones, deduped; a custom color still shows", async () => {
  const { colorRow } = await import("../core/color.js");
  const fixed = ["#1e1e1e", "#e03131"];
  const r = colorRow(fixed, ["#E03131", "#abc", "#aabbcc", "junk"], "#AABBCC");
  expect(r.fixed).toEqual([{ color: "#1e1e1e", active: false }, { color: "#e03131", active: false }]);
  expect(r.saved).toEqual([{ color: "#aabbcc", active: true }]);           // #E03131 is fixed already; #abc = #aabbcc
  expect(r.custom).toBe(null);
  expect(colorRow(fixed, [], "#E03131").fixed[1].active).toBe(true);
  expect(colorRow(fixed, [], "#123456").custom).toBe("#123456");
  expect(colorRow(fixed, [], "transparent").custom).toBe("transparent");
  expect(colorRow(fixed, [], undefined).custom).toBe(null);
});

test("picker model: grid marks the current color; recent drops none for strokes; save only what isn't one click away", async () => {
  const { pickerModel, swatchGrid } = await import("../core/color.js");
  const g = swatchGrid(12, 5), pick = g[2][4];
  const m = pickerModel({ kind: "stroke", fixed: ["#1e1e1e"], saved: ["#00ff00"], recent: ["transparent", pick.toUpperCase(), "#00ff00"], current: pick });
  expect(m.grid.length).toBe(5);
  expect(m.grid.flat().filter(c => c.active)).toEqual([{ color: pick, active: true }]);
  expect(m.recent.map(c => c.color)).toEqual([pick, "#00ff00"]);
  expect(m.recent[0].active).toBe(true);
  expect(m.canSave).toBe(true);
  expect(m.none).toBe(null);
  expect(m.hex).toBe(pick);
  expect(pickerModel({ kind: "stroke", fixed: ["#1e1e1e"], saved: ["#00ff00"], recent: [], current: "#00FF00" }).canSave).toBe(false);
  expect(pickerModel({ kind: "stroke", fixed: ["#1e1e1e"], saved: [], recent: [], current: "#1e1e1e" }).canSave).toBe(false);
  const f = pickerModel({ kind: "fill", fixed: [], saved: [], recent: ["transparent"], current: "transparent" });
  expect(f.none).toEqual({ active: true });
  expect(f.recent.map(c => c.color)).toEqual(["transparent"]);
  expect(f.canSave).toBe(false);
  expect(f.hex).toBe("");
});

test("picker hex field: colors parse, anything else is a short message", async () => {
  const { parseColorInput } = await import("../core/color.js");
  expect(parseColorInput(" 1971C2 ")).toEqual({ color: "#1971c2" });
  expect(parseColorInput("#f0a")).toEqual({ color: "#ff00aa" });
  const bad = parseColorInput("purple-ish blue");
  expect(bad.color).toBeUndefined();
  expect(bad.error).toContain("isn't a color");
  expect(bad.error.length).toBeLessThan(50);
});
