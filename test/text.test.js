import { test, expect, afterAll } from "bun:test";
import { wrapLines, labelLines, textWidth, labelHostHeight } from "../core/text.js";
import { setup, THEME } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";
import { bbox } from "../core/geometry.js";

afterAll(closeRaster);

test("wrapLines: word wrap, explicit newlines, long words broken", () => {
  // Mono (fontFamily 3) at 20px is 12px per char: 120px fits 10 chars.
  expect(wrapLines("the quick brown fox jumps", 120, 20, 3)).toEqual(["the quick", "brown fox", "jumps"]);
  expect(wrapLines("a\nb", 500, 20, 3)).toEqual(["a", "b"]);
  expect(wrapLines("abcdefghijklmnopqrstuvwxyz", 120, 20, 3)).toEqual(["abcdefghi", "jklmnopqr", "stuvwxyz"]);   // even pieces
  expect(wrapLines("", 100, 20, 3)).toEqual([""]);
  expect(wrapLines("is the signature valid", 90, 20, 3)).toEqual(["is the", "signa", "ture", "valid"]);   // too wide: even pieces, no stub
});

test("wrapLines: a word too wide for its line breaks at its seams before its letters, and never spills", () => {
  const w = (t, max) => wrapLines(t, max, 20, 2);
  expect(w("(EvaluateNdcFraudBlock)", 150)).toEqual(["(EvaluateNdc", "FraudBlock)"]);
  expect(w("EvaluateNdcFraudBlock", 100)).toEqual(["Evaluate", "NdcFraud", "Block"]);
  expect(w("evaluate_ndc_fraud_block_handler", 160)).toEqual(["evaluate_ndc_", "fraud_block_", "handler"]);
  expect(w("HTTPServerError", 80)).toEqual(["HTTP", "Server", "Error"]);
  expect(w("/usr/local/lib/payments", 100)[0]).toBe("/usr/local/");
  // Whatever the text and width, no line is wider than the width (one char a line at the least).
  for (const t of ["(EvaluateNdcFraudBlock)", "com.example.payments.FraudService", "supercalifragilistic", "a_b-c.d/e:f", "WWWWWWWW iii", "日本語のテキスト"])
    for (const max of [30, 45, 60, 90, 140, 200])
      for (const line of wrapLines(t, max, 20, 2)) expect(textWidth(line, 20, 2) <= max || [...line].length === 1).toBe(true);
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

// Live, 2026-11-08: this sentence at 40px in the isolated Herdr pane (zoom 1.2, 2x display) measured
// 1944 / 1979 / 2462 device px of ink for sans / hand / mono, i.e. 0.471 / 0.479 / 0.596 per char.
test("textWidth matches the pane's rendered fonts, glyph by glyph", () => {
  const s = "The quick brown fox jumps over the lazy dog", per = ff => textWidth(s, 40, ff) / (40 * s.length);
  expect(per(2)).toBeCloseTo(0.471, 1); expect(Math.abs(per(2) - 0.471)).toBeLessThan(0.01);
  expect(Math.abs(per(5) - 0.479)).toBeLessThan(0.01);
  expect(per(3)).toBeCloseTo(0.6, 6);
  expect(textWidth("MMMM", 20, 2)).toBeGreaterThan(3 * textWidth("iiii", 20, 2));   // glyphs, not a flat average
  expect(textWidth("漢字", 20, 2)).toBeCloseTo(40, 6);                                // wide chars take an em
  expect(textWidth("é", 20, 2)).toBeGreaterThan(0);
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
  for (const [k, x] of [["r", 10], ["d", 310], ["o", 610]]) {   // 280 wide: the rectangle fits the text on one line
    t.key(k); t.drag([x, 100], [x + 280, 200]);
    t.dblclick([x + 140, 150]); t.type("one two three four five six");
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

test("switching a label to a wider font refits its shape; free text takes the new width", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [300, 160]);
  t.dblclick([200, 130]); t.type("Validate the incoming webhook payload now"); t.key("escape");
  const [r] = t.byType("rectangle"), h0 = t.ed.doc.get(r.id).height;
  t.ed.select([r.id]); t.ed.setStyle({ fontFamily: 3 });
  const host = t.ed.doc.get(r.id), label = t.ed.doc.labelOf(host);
  expect(host.height).toBeGreaterThan(h0);
  expect(host.height).toBeGreaterThanOrEqual(labelHostHeight(label, host) - 1e-9);
  t.key("t"); t.click([500, 400]); t.type("hello world"); t.key("escape");
  const txt = t.byType("text").find(e => !e.containerId);
  t.ed.select([txt.id]); t.ed.setStyle({ fontFamily: 3 });
  expect(t.ed.doc.get(txt.id).width).toBeCloseTo(textWidth("hello world", txt.fontSize, 3), 6);
  t.ed.setStyle({ fontSize: 40 });
  expect(t.ed.doc.get(txt.id).width).toBeCloseTo(textWidth("hello world", 40, 3), 6);
});
