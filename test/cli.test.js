// Contract: whatever `drawh` (the agents' CLI) writes, the core reads, layers and animates correctly.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Editor } from "../core/editor.js";
import { animState } from "../core/anim.js";
import { resolvedPoints } from "../core/geometry.js";

const ROOT = new URL("..", import.meta.url).pathname;
const drawh = (...a) => { const r = Bun.spawnSync([`${ROOT}cli/drawh`, ...a]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

test("drawh boards load with their layers, bindings and animation", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  drawh("grid", f, "A", "B", "--layer", "Flow");
  drawh("arrow", f, "A", "B");
  drawh("text", f, "note", "--at", "0,-50", "--layer", "Notes");
  drawh("layer", f, "Notes", "--hide");
  drawh("animate", f, "A", "B", "--preset", "rise", "--duration", "400");
  const ed = new Editor({ scene: JSON.parse(readFileSync(f, "utf8")) });
  expect(ed.doc.layers.map(l => l.name)).toEqual(["Layer 1", "Flow", "Notes"]);
  expect(ed.doc.visible().some(e => e.text === "note")).toBe(false);          // hidden layer
  const arrow = ed.doc.live().find(e => e.type === "arrow");
  const pts = resolvedPoints(ed.doc, arrow);
  expect(pts[0][0]).toBeGreaterThan(160);                                      // starts at A's right edge
  const b = ed.doc.live().find(e => e.type === "rectangle" && e.customData.anim?.start === 150);
  expect(animState(b, 150).opacity).toBe(0);
  expect(ed.displayList({ fg: "#fff", bg: "#000", accent: "#0ff", dim: "#888" }).length).toBeGreaterThan(4);
});
