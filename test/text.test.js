import { test, expect, afterAll } from "bun:test";
import { wrapLines, labelLines, textWidth } from "../core/text.js";
import { setup, THEME } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";
import { bbox } from "../core/geometry.js";

afterAll(closeRaster);

test("wrapLines: word wrap, explicit newlines, long words broken", () => {
  // Mono (fontFamily 3) at 20px is 12px per char: 120px fits 10 chars.
  expect(wrapLines("the quick brown fox jumps", 120, 20, 3)).toEqual(["the quick", "brown fox", "jumps"]);
  expect(wrapLines("a\nb", 500, 20, 3)).toEqual(["a", "b"]);
  expect(wrapLines("abcdefghijklmnopqrstuvwxyz", 120, 20, 3)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
  expect(wrapLines("", 100, 20, 3)).toEqual([""]);
  expect(wrapLines("is the signature valid", 90, 20, 3)).toEqual(["is the", "signature", "valid"]);   // 9 chars on a 7-char line stays whole
});

test("wrapLines always ends, whatever the width or size (a hostile board can't hang the pane)", () => {
  for (const [w, fs] of [[0, 20], [-50, 20], [NaN, 20], [100, 0], [100, -5], [100, NaN], [Infinity, 20], [100, Infinity]]) {
    const lines = wrapLines("supercalifragilistic word", w, fs, 2);
    expect(lines.length).toBeLessThan(40);
  }
});

// Measured 2026-11-08 in headless Chromium, average width per char / font size: system UI sans 0.41-0.47,
// Chalkboard SE / Comic Sans 0.47-0.53, Menlo / Berkeley Mono 0.60. The old single 0.56 made mono overflow.
test("textWidth: each font family at its own width; mono is exact", () => {
  expect(textWidth("MMMM", 20, 3)).toBeCloseTo(48, 6);
  const s = "Validate the payload", sans = textWidth(s, 20, 2), hand = textWidth(s, 20, 5), mono = textWidth(s, 20, 3);
  expect(sans).toBeLessThan(hand); expect(hand).toBeLessThan(mono);
  expect(sans / (20 * s.length)).toBeGreaterThan(0.42);   // never much narrower than the real font: text must fit
  expect(wrapLines(s, 130, 20, 3).length).toBeGreaterThan(wrapLines(s, 130, 20, 2).length);
});

test("a mono label's file box is as wide as mono text", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [400, 160]);
  t.dblclick([250, 130]); t.type("abcdefghij"); t.key("escape");
  const [r] = t.byType("rectangle");
  t.ed.select([r.id]); t.ed.setStyle({ fontFamily: 3 });
  const l = t.ed.scene().elements.find(e => e.type === "text");
  expect(l.fontFamily).toBe(3);
  expect(l.width).toBeCloseTo(10 * 0.6 * l.fontSize, 6);
});

test("a long label wraps inside its box and the box grows to fit", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [260, 160]);            // 160 x 60
  t.dblclick([180, 130]);
  t.type("Validate the incoming webhook payload against the schema");
  const [r] = t.byType("rectangle"), [label] = t.byType("text");
  const lines = labelLines(label, r);
  expect(lines.length).toBeGreaterThan(2);
  expect(r.height).toBeGreaterThanOrEqual(lines.length * 20 * 1.25 + 16);
  expect(r.width).toBe(160);                              // width is the person's choice
  const item = t.ed.displayList(THEME).find(i => i.t === "text");
  expect(item.text.split("\n").length).toBe(lines.length);
});

test("diamonds and ellipses wrap narrower than rectangles", () => {
  const t = setup();
  for (const [k, x] of [["r", 50], ["d", 300], ["o", 550]]) {
    t.key(k); t.drag([x, 100], [x + 200, 200]);
    t.dblclick([x + 100, 150]); t.type("one two three four five six");
  }
  const n = type => { const host = t.byType(type)[0]; return labelLines(t.ed.doc.labelOf(host), host).length; };
  expect(n("diamond")).toBeGreaterThan(n("rectangle"));
  expect(n("ellipse")).toBeGreaterThan(n("rectangle"));
});

test("narrowing a labeled box rewraps the label and keeps it inside", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [400, 160]);
  t.dblclick([250, 130]); t.type("a label that fits on one line here");
  t.click([250, 100]);                                    // select by the outline
  const before = t.byType("rectangle")[0].height;
  const se = t.ed.handles().find(h => h.dir === "se");    // the box already grew to fit its label
  t.drag([se.x, se.y], [se.x - 200, se.y]);               // drag the se handle left
  const r = t.byType("rectangle")[0];
  expect(r.width).toBeCloseTo(100, 0);
  expect(r.height).toBeGreaterThan(before);
});

test("bigger font grows the box", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [300, 160]);
  t.dblclick([200, 130]); t.type("deploy pipeline");
  const h = t.byType("rectangle")[0].height;
  t.ed.setStyle({ fontSize: 36 });
  expect(t.byType("rectangle")[0].height).toBeGreaterThan(h);
});

test("multi-line free text has a multi-line box", () => {
  const t = setup();
  t.key("t"); t.click([100, 100]); t.type("first line\nsecond line\nthird");
  const [txt] = t.byType("text");
  expect(bbox(txt).h).toBeCloseTo(3 * 20 * 1.25, 0);
});

test("snapshot: wrapped labels", async () => {
  const t = setup();
  t.key("r"); t.drag([40, 60], [220, 120]); t.dblclick([130, 90]); t.type("Validate the incoming webhook payload");
  t.key("d"); t.drag([280, 40], [500, 160]); t.dblclick([390, 100]); t.type("Is the signature valid?");
  t.key("o"); t.drag([560, 60], [760, 140]); t.key("b"); t.dblclick([660, 100]); t.type("Store event and acknowledge");
  t.key("a"); t.drag([130, 90], [390, 100]); t.key("a"); t.drag([390, 100], [660, 100]);
  t.key("escape");
  const svg = await t.shot("wrapped-labels");
  expect(svg).toContain("webhook");
});
