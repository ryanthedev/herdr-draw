// Contract: whatever `drawh` (the agents' CLI) writes, the core reads, layers and animates correctly.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("drawh export: a cropped 2x PNG (or --svg) without the pane, on the board's page color", () => {
  const dir = mkdtempSync(`${tmpdir()}/drawh-`), f = `${dir}/b.excalidraw`;
  drawh("add", f, "rect", "--at", "0,0", "--w", "200", "--h", "100", "--label", "Hi");
  drawh("image", f, `${ROOT}test/fixtures/tiny.png`, "--at", "260,0", "--w", "80");
  const png = drawh("export", f);
  expect(png).toBe(`${dir}/b.png`);
  const dims = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", png]).stdout.toString();
  const svg = drawh("export", f, "--svg", "--out", `${dir}/x.svg`);
  const s = readFileSync(svg, "utf8");
  const [, vw, vh] = /viewBox="0 0 (\d+) (\d+)"/.exec(s).map(Number);
  expect(+/pixelWidth: (\d+)/.exec(dims)[1]).toBe(vw * 2);
  expect(+/pixelHeight: (\d+)/.exec(dims)[1]).toBe(vh * 2);
  expect(vw).toBeGreaterThan(340); expect(vw).toBeLessThan(420);   // 340 wide + padding: cropped, not a fixed page
  expect(s).toContain('fill="#ffffff"');
  expect(s).toContain("<image href=\"data:image/png;base64,");
  expect(readFileSync(drawh("export", f, "--svg", "--dark", "--out", `${dir}/d.svg`), "utf8")).toContain('fill="#121212"');
});

test("drawh lib: save elements from a board, list, insert into another board (still bound), import, remove", () => {
  const dir = mkdtempSync(`${tmpdir()}/drawh-`), a = `${dir}/a.excalidraw`, b = `${dir}/b.excalidraw`, lib = `${dir}/lib.excalidrawlib`;
  drawh("add", a, "rect", "--at", "0,0", "--label", "Client");
  drawh("add", a, "rect", "--at", "300,0", "--label", "Server");
  drawh("arrow", a, "Client", "Server");
  const arrow = JSON.parse(readFileSync(a, "utf8")).elements.find(e => e.type === "arrow").id;
  expect(drawh("lib", "add", a, "Client", "Server", arrow, "--name", "Client/server", "--lib", lib)).toMatch(/^\S+$/);
  expect(drawh("lib", "ls", "--lib", lib)).toContain("Client/server");
  drawh("add", b, "ellipse", "--at", "0,0");
  const ids = drawh("lib", "insert", b, "Client/server", "--lib", lib).split("\n");
  const ed = new Editor({ scene: JSON.parse(readFileSync(b, "utf8")) });
  const ar = ed.doc.live().find(e => e.type === "arrow");
  expect(ids).toContain(ar.id);
  expect(ids).toContain(ar.startBinding.elementId);
  expect(ids).toContain(ar.endBinding.elementId);
  expect(ed.doc.live().filter(e => e.type === "text").map(e => e.text).sort()).toEqual(["Client", "Server"]);
  const top = Math.min(...ed.doc.live().filter(e => ids.includes(e.id) && e.type === "rectangle").map(e => e.y));
  expect(top).toBeGreaterThanOrEqual(80);                                      // below what was there
  // Import an excalidraw.com library (v1), then remove an item by name.
  writeFileSync(`${dir}/x.excalidrawlib`, JSON.stringify({ type: "excalidrawlib", version: 1, library: [[{ id: "z", type: "diamond", x: 0, y: 0, width: 50, height: 50 }]] }));
  expect(drawh("lib", "import", `${dir}/x.excalidrawlib`, "--lib", lib)).toContain("1 item");
  expect(drawh("lib", "ls", "--lib", lib).split("\n").length).toBe(2);
  drawh("lib", "rm", "Client/server", "--lib", lib);
  expect(drawh("lib", "ls", "--lib", lib)).not.toContain("Client/server");
  expect(JSON.parse(readFileSync(lib, "utf8"))).toMatchObject({ type: "excalidrawlib", version: 2 });
});
