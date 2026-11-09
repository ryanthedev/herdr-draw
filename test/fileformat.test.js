// What the file says must be what excalidraw.com draws. Excalidraw paints a label from its own
// x / y / width / height (it doesn't center it in the shape on load); our renderer derives them,
// so the file must carry them derived too. (Checked 2026-11-08 by dropping boards into
// excalidraw.com in headless Chromium: drawh labels sat in the top-left corner, Mermaid labels
// with width 0 didn't show at all.)
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Editor } from "../core/editor.js";
import { alongPath, resolvedPoints } from "../core/geometry.js";
import { setup } from "./harness/fixture.js";

const ROOT = new URL("..", import.meta.url).pathname;
const drawh = (...a) => { const r = Bun.spawnSync([`${ROOT}cli/drawh`, ...a]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
const mid = e => [e.x + e.width / 2, e.y + e.height / 2];
const close = (p, q, tol = 1) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;

function expectCentered(scene) {
  const by = new Map(scene.elements.map(e => [e.id, e]));
  const labels = scene.elements.filter(e => e.type === "text" && e.containerId && !e.isDeleted);
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) {
    const host = by.get(l.containerId);
    expect(l.width).toBeGreaterThan(0); expect(l.height).toBeGreaterThan(0);
    if (host.type === "arrow" || host.type === "line") {
      const ed = new Editor({ scene });
      expect(close(mid(l), alongPath(resolvedPoints(ed.doc, ed.doc.get(host.id))))).toBe(true);
    } else expect(close(mid(l), mid(host))).toBe(true);
  }
}

test("drawh writes labels centered in their shapes and on their arrows", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  drawh("add", f, "rect", "--at", "0,0", "--id", "A", "--label", "Start here");
  drawh("add", f, "ellipse", "--at", "400,0", "--id", "B", "--label", "End");
  drawh("arrow", f, "A", "B", "--label", "go");
  drawh("label", f, "A", "Begin");
  const s = JSON.parse(readFileSync(f, "utf8")), arrow = s.elements.find(e => e.type === "arrow");
  expect(s.elements.find(e => e.type === "text" && e.text === "go").containerId).toBe(arrow.id);   // bound, so it rides along
  expect(arrow.boundElements).toContainEqual(expect.objectContaining({ type: "text" }));
  expectCentered(s);
});

test("drawh bakes straight bound arrows to the shapes' outlines, not their centers", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  drawh("add", f, "rect", "--at", "0,0", "--id", "A");
  drawh("add", f, "rect", "--at", "400,200", "--id", "B");
  drawh("arrow", f, "A", "B");
  const s = JSON.parse(readFileSync(f, "utf8")), a = s.elements.find(e => e.type === "arrow");
  const end = [a.x + a.points.at(-1)[0], a.y + a.points.at(-1)[1]];
  const ed = new Editor({ scene: s }), want = resolvedPoints(ed.doc, ed.doc.get(a.id));
  expect(close([a.x, a.y], want[0])).toBe(true);
  expect(close(end, want.at(-1))).toBe(true);
  expect(a.x).toBeGreaterThan(140);   // left A's right side
});

test("Mermaid labels get a real size, centered", () => {
  const t = setup();
  t.ed.paste("graph LR\n  A[Start] -->|next| B{Choice}\n  B --> C((Done))", { x: 400, y: 300 });
  expectCentered(t.ed.scene());
});

test("labels follow their shape when it moves", () => {
  const t = setup();
  t.ed.paste("graph LR\n  A[Start] --> B[Stop]", { x: 400, y: 300 });
  t.key("escape");
  const [r] = t.byType("rectangle");
  t.drag([r.x + 5, r.y + 5], [r.x + 205, r.y + 105]);
  expectCentered(t.ed.scene());
});
