import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseMermaid, layoutGraph, mermaidToElements, isMermaid } from "../core/mermaid.js";
import { Editor } from "../core/editor.js";
import { bbox, boxInBox } from "../core/geometry.js";
import { setup } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";

afterAll(closeRaster);
const ROOT = new URL("..", import.meta.url).pathname;

test("parser: shapes, labels, edge styles, chains, &, comments", () => {
  const g = parseMermaid(`flowchart LR
    %% a comment
    A[Start here] --> B(Rounded) --> C{Decide}
    C -->|yes| D((Done))
    C -. no .-> E[(Store)]
    A & B --- F>Flag]
    G ==> A
    classDef x fill:#f00
    style A fill:#0f0`);
  expect(g.dir).toBe("LR");
  expect(g.nodes.get("A").label).toBe("Start here");
  expect(g.nodes.get("B").rounded).toBe(true);
  expect(g.nodes.get("C").type).toBe("diamond");
  expect(g.nodes.get("D").type).toBe("ellipse");
  expect(g.edges.find(e => e.from === "C" && e.to === "D").label).toBe("yes");
  const no = g.edges.find(e => e.to === "E");
  expect([no.label, no.style]).toEqual(["no", "dashed"]);
  expect(g.edges.filter(e => e.to === "F").map(e => e.from).sort()).toEqual(["A", "B"]);
  expect(g.edges.find(e => e.to === "F").head).toBe(false);
  expect(g.edges.find(e => e.from === "G").style).toBe("thick");
  expect(g.edges.find(e => e.from === "A" && e.to === "B")).toBeTruthy();   // chain
});

test("parser: no spaces, <br> line breaks, quoted labels, semicolons", () => {
  const g = parseMermaid(`graph TD;A-->B;B["two<br>lines"]-->C`);
  expect(g.edges.length).toBe(2);
  expect(g.nodes.get("B").label).toBe("two\nlines");
  expect(() => parseMermaid("sequenceDiagram\n A->>B: hi")).toThrow();
  expect(isMermaid("  graph LR\nA-->B")).toBe(true);
  expect(isMermaid("hello")).toBe(false);
});

test("layout: ranks follow the flow, nothing overlaps, cycles don't hang", () => {
  const g = parseMermaid(`graph TD
    A --> B & C
    B --> D
    C --> D
    D --> A`);
  const p = layoutGraph(g);
  expect(p.get("B").y).toBeGreaterThan(p.get("A").y);
  expect(p.get("D").y).toBeGreaterThan(p.get("B").y);
  const boxes = [...p.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
  }
  const lr = layoutGraph(parseMermaid("graph LR\nA-->B")), bt = layoutGraph(parseMermaid("graph BT\nA-->B"));
  expect(lr.get("B").x).toBeGreaterThan(lr.get("A").x);
  expect(bt.get("B").y).toBeLessThan(bt.get("A").y);
});

test("elements: labeled shapes, bound arrows with labels, subgraph frames around their nodes", () => {
  const { elements } = mermaidToElements(`flowchart TD
    subgraph api [API tier]
      G[Gateway] --> S[Service]
    end
    U[User] -->|calls| G`);
  const ed = new Editor({ scene: { elements } });
  const frame = ed.doc.live().find(e => e.type === "frame");
  expect(frame.name).toBe("API tier");
  const gw = ed.doc.live().find(e => ed.doc.labelOf(e)?.text === "Gateway");
  expect(boxInBox(bbox(gw), bbox(frame))).toBe(true);
  const arrows = ed.doc.live().filter(e => e.type === "arrow");
  expect(arrows.length).toBe(2);
  expect(arrows.every(a => a.startBinding && a.endBinding)).toBe(true);
  expect(ed.doc.labelOf(arrows.find(a => a.endBinding.elementId === gw.id)).text).toBe("calls");
});

test("pasting Mermaid into the board imports it, selected and undoable", () => {
  const t = setup();
  t.ed.paste("graph LR\n  A[One] --> B[Two] --> C[Three]");
  expect(t.byType("rectangle").length).toBe(3);
  expect(t.byType("arrow").length).toBe(2);
  expect(t.ed.sel.size).toBe(5);
  t.key("z", { cmd: true });
  expect(t.live().length).toBe(0);
});

test("drawh mermaid: stdin import lands below existing content, loads in the core", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  const run = (args, input) => { const r = Bun.spawnSync([`${ROOT}cli/drawh`, ...args], { stdin: input ? new TextEncoder().encode(input) : undefined }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString(); };
  run(["add", f, "rect", "--at", "0,0"]);
  run(["text", f, "a note\nthat is\ntall", "--at", "0,100"]);   // free text below the box: imports go below it too
  const ids = run(["mermaid", f], "graph TD\n  A[Plan] --> B[Ship]").trim().split("\n");
  expect(ids.length).toBe(3);
  const ed = new Editor({ scene: JSON.parse(readFileSync(f, "utf8")) });
  const plan = ed.doc.live().find(e => ed.doc.labelOf(e)?.text === "Plan");
  expect(plan.y).toBeGreaterThanOrEqual(100 + 75 + 80);   // below the note (100..175) plus the gap
  const bad = Bun.spawnSync([`${ROOT}cli/drawh`, "mermaid", f], { stdin: new TextEncoder().encode("pie title x") });
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr.toString()).toContain("not a Mermaid flowchart");
});

test("snapshot: an imported flowchart", async () => {
  const t = setup({ w: 1000, h: 700 });
  t.ed.paste(`flowchart TD
    U[User] -->|HTTPS| G{Signed in?}
    G -->|yes| A[API gateway]
    G -. no .-> L([Login page])
    subgraph backend [Backend]
      A --> S[Orders service] --> D[(Postgres)]
      A --> Q[Queue]
    end`, { x: 500, y: 340 });
  t.key("escape");
  const svg = await t.shot("mermaid");
  expect(svg).toContain("Orders service");
  // Imported content is all on screen, and the frame holds only its members.
  for (const e of t.live().filter(e => e.type !== "text")) {
    const b = bbox(e), a = t.ed.toScreen(b), z = t.ed.toScreen({ x: b.x + b.w, y: b.y + b.h });
    expect(a.x >= -1 && a.y >= -1 && z.x <= 1001 && z.y <= 701).toBe(true);
  }
  const frame = t.byType("frame")[0];
  const login = t.live().find(e => t.ed.doc.labelOf(e)?.text === "Login page");
  expect(boxInBox(bbox(login), bbox(frame))).toBe(false);
  const fb = bbox(frame), lb = bbox(login);
  expect(lb.x >= fb.x + fb.w || lb.x + lb.w <= fb.x || lb.y >= fb.y + fb.h || lb.y + lb.h <= fb.y).toBe(true);
});
