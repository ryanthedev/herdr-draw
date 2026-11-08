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

test("drawh: \\n in a label is a line break", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  drawh("add", f, "rect", "--at", "0,0", "--label", "two\\nlines");
  const ed = new Editor({ scene: JSON.parse(readFileSync(f, "utf8")) });
  expect(ed.doc.live().find(e => e.type === "text").text).toBe("two\nlines");
});

test("drawh rotate and --angle set Excalidraw angles the core reads", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`;
  const id = drawh("add", f, "rect", "--at", "0,0", "--label", "x", "--angle", "30");
  drawh("rotate", f, id, "15");
  const ed = new Editor({ scene: JSON.parse(readFileSync(f, "utf8")) });
  const r = ed.doc.get(id);
  expect(Math.round(r.angle * 180 / Math.PI)).toBe(45);
  expect(ed.doc.labelOf(r).angle).toBeCloseTo(r.angle, 9);
});

test("drawh image: an agent puts a picture on the board, file and all; same bytes, same id", () => {
  const f = `${mkdtempSync(`${tmpdir()}/drawh-`)}/b.excalidraw`, png = `${ROOT}test/fixtures/tiny.png`;
  drawh("add", f, "rect", "--at", "0,0", "--label", "Above");
  const id = drawh("image", f, png, "--w", "160");
  const scene = JSON.parse(readFileSync(f, "utf8"));
  const img = scene.elements.find(e => e.id === id);
  const sha = new Bun.CryptoHasher("sha1").update(readFileSync(png)).digest("hex");
  expect(img).toMatchObject({ type: "image", fileId: sha, width: 160, height: 80, status: "saved" });
  expect(img.y).toBeGreaterThanOrEqual(80);                                    // below what was there
  expect(scene.files[sha]).toMatchObject({ id: sha, mimeType: "image/png" });
  expect(Buffer.from(scene.files[sha].dataURL.split(",")[1], "base64").equals(readFileSync(png))).toBe(true);
  // The pane reads it as an image with its pixels.
  const ed = new Editor({ scene });
  expect(ed.displayList({ fg: "#fff", bg: "#000", accent: "#0ff", dim: "#888" }).some(i => i.t === "image" && i.fileId === sha)).toBe(true);
  // The same picture twice shares one file.
  drawh("image", f, png, "--at", "300,0");
  const again = JSON.parse(readFileSync(f, "utf8"));
  expect(Object.keys(again.files)).toEqual([sha]);
  expect(() => drawh("image", f, `${ROOT}README.md`)).toThrow();
});
