import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setup } from "./harness/fixture.js";
import { mermaidToElements } from "../core/mermaid.js";
import { overlaps } from "../core/lint.js";
import { labelLines, textWidth, labelHostWidth, LABEL_PAD } from "../core/text.js";
import { makeElement } from "../core/model.js";

const ROOT = new URL("..", import.meta.url).pathname;
const fits = (label, host) => labelLines(label, host).every(l => textWidth(l, label.fontSize, label.fontFamily) <= Math.abs(host.width) - LABEL_PAD * 2);

test("a box is never narrower than its label's longest word: typing widens it about its center", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [220, 160]);            // 120 wide
  t.dblclick([160, 130]); t.type("NDC fraud block (EvaluateNdcFraudBlock)");
  const [r] = t.byType("rectangle"), [label] = t.byType("text");
  expect(r.width).toBe(labelHostWidth(label, "rectangle"));
  expect(r.x + r.width / 2).toBeCloseTo(160, 5);          // same center
  expect(labelLines(label, r)).toEqual(["NDC fraud block", "(EvaluateNdcFraudBlock)"]);
  expect(fits(label, r)).toBe(true);
});

test("narrowing a labeled box stops at its longest word, on the side being dragged", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [500, 160]);
  t.dblclick([300, 130]); t.type("call EvaluateNdcFraudBlock");
  t.click([300, 100]);
  const se = t.ed.handles().find(h => h.dir === "se");
  t.drag([se.x, se.y], [110, se.y]);
  const r = t.byType("rectangle")[0], label = t.ed.doc.labelOf(r);
  expect(r.x).toBeCloseTo(100, 5);                        // the left edge stays put
  expect(r.width).toBe(labelHostWidth(label, "rectangle"));
  expect(fits(label, r)).toBe(true);
});

// Diagrams that used to overlap: long words, diamonds, edge labels both ways, skipped ranks,
// cycles, A→B with B→A, a subgraph with an edge past it.
const FIX = {
  longWord: `flowchart LR\n A[Request] --> B["NDC fraud block<br>(EvaluateNdcFraudBlock)"] --> C[Decline]\n B --> D[Next]`,
  identifiers: `flowchart TD\n A[evaluate_ndc_fraud_block_handler] --> B[com.example.payments.FraudService]`,
  diamonds: `flowchart TD\n A{Authorized?} -->|yes| B((Settlement))\n A -->|no| C{RiskScoreAboveThreshold}`,
  edgeLabelsLR: `flowchart LR\n A[Start] -->|calls the fraud service synchronously| B[Fraud]\n B -->|returns a verdict| C[End]`,
  edgeLabelsTD: `flowchart TD\n A[Start] -->|calls the fraud service synchronously| B[Fraud]\n A -->|logs| B2[Audit]`,
  skipRank: `flowchart TD\n A --> B --> C --> D\n A --> D`,
  skipRankLR: `flowchart LR\n A[One] --> B[Two] --> C[Three]\n A --> C`,
  cycle: `flowchart TD\n A --> B --> C --> A`,
  bothWays: `flowchart LR\n A[Client] -->|request| B[Server]\n B -->|response| A`,
  subgraph: `flowchart TD\n subgraph G[Group]\n A --> B\n end\n X --> A\n B --> Y\n X --> Y`,
  labelSkip: `flowchart TD\n A --> B --> C\n A -->|on failure, retry| C`,
  labelCycle: `flowchart TD\n A --> B --> C\n C -->|retry later| A`,
  mixed: `flowchart TD\n U[User] -->|HTTPS| G{Signed in?}\n G -->|yes| A[API gateway]\n G -. no .-> L([Login page])\n subgraph backend [Backend]\n A --> S[Orders service] --> D[(Postgres)]\n A --> Q[Queue]\n end\n Q -->|retry| A`,
};
for (const elbow of [false, true]) test(`Mermaid (${elbow ? "elbow" : "straight"}): no label spills, nothing overlaps, in every direction`, () => {
  for (const dir of ["TD", "LR", "BT", "RL"]) for (const [name, src] of Object.entries(FIX)) {
    const els = mermaidToElements(src.replace(/^flowchart \w+/, `flowchart ${dir}`), { elbow }).elements;
    expect([dir, name, overlaps(els).map(p => p.msg)]).toEqual([dir, name, []]);
  }
});

test("Mermaid: edges between neighbouring ranks stay straight unless they'd collide", () => {
  const arrows = src => mermaidToElements(src).elements.filter(e => e.type === "arrow");
  expect(arrows(`flowchart TD\n A --> B & C & D`).every(a => a.points.length === 2)).toBe(true);
  const both = arrows(`flowchart LR\n A --> B\n B --> A`);
  expect(both.every(a => a.points.length === 3 && a.roundness)).toBe(true);   // A→B and B→A part ways
});

test("the checker leaves containers and unbound lines alone", () => {
  const big = makeElement("rectangle", { id: "big", x: 0, y: 0, width: 600, height: 300 });
  const a = makeElement("rectangle", { id: "a", x: 40, y: 100, width: 140, height: 80 }), b = makeElement("rectangle", { id: "b", x: 400, y: 100, width: 140, height: 80 });
  const ar = makeElement("arrow", { id: "ar", x: 186, y: 140, points: [[0, 0], [208, 0]], startBinding: { elementId: "a", gap: 6 }, endBinding: { elementId: "b", gap: 6 }, boundElements: [{ id: "t", type: "text" }] });
  const t = makeElement("text", { id: "t", text: "calls", originalText: "calls", fontSize: 16, fontFamily: 2, containerId: "ar" });
  const deco = makeElement("line", { x: -50, y: 50, points: [[0, 0], [700, 0]] });
  expect(overlaps([big, a, b, ar, t, deco])).toEqual([]);
});

test("the checker sees each kind of overlap", () => {
  const box = (id, x, y, w = 140, h = 80) => makeElement("rectangle", { id, x, y, width: w, height: h });
  const label = (host, text) => { const l = makeElement("text", { text, originalText: text, fontSize: 20, fontFamily: 2, containerId: host.id }); host.boundElements = [{ id: l.id, type: "text" }]; return l; };
  const a = box("a", 0, 0, 120), b = box("b", 400, 0), c = box("c", 200, -20), d = box("d", 100, 40);
  const arrow = makeElement("arrow", { x: 130, y: 40, points: [[0, 0], [260, 0]], startBinding: { elementId: "a", gap: 6 }, endBinding: { elementId: "b", gap: 6 } });
  const msgs = overlaps([a, label(a, "EvaluateNdcFraudBlock"), b, c, d, arrow]).map(p => p.msg).join("\n");
  expect(msgs).toContain("\"EvaluateNdcFraudBlock\" is ");
  expect(msgs).toContain("crosses \"c\"");
  expect(msgs).toMatch(/"EvaluateNdcFraudBlock" and rectangle "d" overlap/);
});

test("drawh: add widens a box for its longest word, grid cells fit every label, check lists overlaps", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`, g = f.replace("b.", "g.");
  const run = args => Bun.spawnSync([`${ROOT}cli/drawh`, ...args]);
  run(["add", f, "rect", "--at", "0,0", "--w", "140", "--label", "NDC fraud block\\n(EvaluateNdcFraudBlock)", "--id", "ndc"]);
  const els = JSON.parse(readFileSync(f, "utf8")).elements, ndc = els.find(e => e.id === "ndc"), lab = els.find(e => e.containerId === "ndc");
  expect(ndc.width).toBe(labelHostWidth(lab, "rectangle"));
  expect(ndc.x + ndc.width / 2).toBeCloseTo(70, 5);
  expect(run(["check", f]).exitCode).toBe(0);
  run(["add", f, "rect", "--at", "220,0", "--id", "dec", "--label", "Decline"]);
  const r = run(["arrow", f, "ndc", "dec", "--label", "a long label that will not fit"]);
  expect(r.stderr.toString()).toContain("drawh: overlap: edge label \"a long label that will not fit\" sits on");
  const ck = run(["check", f]);
  expect(ck.exitCode).toBe(1);
  expect(ck.stdout.toString()).toContain("sits on \"Decline\"");
  run(["grid", g, "short", "evaluate_ndc_fraud_block_handler", "x"]);
  const cells = JSON.parse(readFileSync(g, "utf8")).elements.filter(e => e.type === "rectangle");
  expect(new Set(cells.map(c => c.width)).size).toBe(1);
  expect(run(["check", g]).exitCode).toBe(0);
});
