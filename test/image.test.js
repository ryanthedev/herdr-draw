// Images: Excalidraw `image` elements whose pixels live in the board's `files`.
import { test, expect, afterAll } from "bun:test";
import { setup, THEME, PNG } from "./harness/fixture.js";
import { closeRaster } from "./harness/raster.js";
import { Doc } from "../core/doc.js";
import { Editor } from "../core/editor.js";
import { emptyScene } from "../core/model.js";
import { toSvg } from "../adapters/svg/svg.js";

afterAll(closeRaster);


const FILE = { id: "f1", mimeType: "image/png", dataURL: PNG, width: 80, height: 40 };

test("addImage puts an image element and its file on the board, selected, in one op", () => {
  const t = setup();
  const id = t.ed.addImage(FILE, { x: 300, y: 200 });
  const img = t.ed.doc.get(id);
  expect(img.type).toBe("image");
  expect(img.fileId).toBe("f1");
  expect([img.x, img.y, img.width, img.height]).toEqual([260, 180, 80, 40]);   // centered on `at`
  expect(t.ed.doc.files.f1.dataURL).toBe(PNG);
  expect(t.ed.sel.has(id)).toBe(true);
  // The file travels with the element, so a peer or the file store gets both.
  const op = t.ops.find(o => o.elements?.some(e => e.id === id));
  expect(op.files.f1.mimeType).toBe("image/png");
  expect(t.ed.scene().files.f1).toBeTruthy();
});

test("a big image is scaled down to fit the view, keeping its aspect", () => {
  const t = setup({ w: 900, h: 600 });
  const id = t.ed.addImage({ ...FILE, width: 4000, height: 2000 });
  const img = t.ed.doc.get(id);
  expect(img.width).toBeLessThanOrEqual(900 * 0.6 + 0.01);
  expect(img.width / img.height).toBeCloseTo(2, 5);
});

test("an image is selectable anywhere inside it, and moves by dragging", () => {
  const t = setup();
  const id = t.ed.addImage(FILE, { x: 300, y: 200 });
  t.click([700, 500]); expect(t.ed.sel.size).toBe(0);
  t.click([300, 200]); expect(t.ed.sel.has(id)).toBe(true);
  t.drag([300, 200], [400, 260]);
  const img = t.ed.doc.get(id);
  expect([img.x, img.y]).toEqual([360, 240]);
});

test("resizing an image keeps its aspect ratio; shift frees it", () => {
  const t = setup();
  const id = t.ed.addImage(FILE, { x: 300, y: 200 });   // 260,180 → 340,220
  t.drag([348, 228], [428, 228]);                       // se handle (8px outside), only wider
  let img = t.ed.doc.get(id);
  expect(img.width / img.height).toBeCloseTo(2, 3);
  expect(img.width).toBeCloseTo(160, 0);
  t.drag([428, 268], [428, 368], { shift: true });      // se handle again, now free
  img = t.ed.doc.get(id);
  expect(img.width).toBeCloseTo(160, 0);
  expect(img.height).toBeCloseTo(180, 0);
});

test("undo removes an inserted image; the file stays (harmless, as in Excalidraw)", () => {
  const t = setup();
  const id = t.ed.addImage(FILE);
  t.key("z", { cmd: true });
  expect(t.ed.doc.get(id)).toBeNull();
  t.key("z", { cmd: true, shift: true });
  expect(t.ed.doc.get(id)).toBeTruthy();
});

test("files arrive with ops from elsewhere (an agent's write, a peer) and are add-only", () => {
  const a = setup(), b = new Editor({ scene: emptyScene() });
  a.ed.addImage(FILE);
  for (const op of a.ops) b.receive(op);
  expect(b.doc.files.f1.dataURL).toBe(PNG);
  expect(b.doc.visible().some(e => e.type === "image")).toBe(true);
  // A later op naming the same id doesn't replace the blob (ids are content hashes).
  b.receive({ files: { f1: { ...FILE, dataURL: "data:image/png;base64,AAAA" } } });
  expect(b.doc.files.f1.dataURL).toBe(PNG);
});

test("copy carries the image's file; paste brings files from an excalidraw.com clipboard", () => {
  const a = setup();
  a.ed.addImage(FILE);
  const clip = JSON.parse(a.ed.copy());
  expect(clip.files.f1.dataURL).toBe(PNG);
  const b = setup();
  b.ed.paste(JSON.stringify(clip));
  const img = b.byType("image")[0];
  expect(img.fileId).toBe("f1");
  expect(b.ed.doc.files.f1.dataURL).toBe(PNG);
});

test("the display list has an image item in paint order; a missing file shows a placeholder", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 200]);
  t.ed.addImage(FILE, { x: 150, y: 150 });
  t.key("r"); t.drag([300, 300], [400, 400]);
  t.ed.sel.clear();
  const items = t.ed.displayList(THEME), at = id => items.findIndex(i => i.id === id);
  const [r1, r2] = t.byType("rectangle"), img = t.byType("image")[0];
  const it = items[at(img.id)];
  expect(it.t).toBe("image");
  expect(it).toMatchObject({ fileId: "f1", x: 110, y: 130, w: 80, h: 40 });
  expect(at(r1.id)).toBeLessThan(at(img.id));
  expect(at(img.id)).toBeLessThan(at(r2.id));
  // Without its file: a dashed box where the image goes, never a crash.
  const lost = new Doc(t.ed.scene()); lost.files = {};
  const e2 = new Editor({ scene: { elements: lost.toScene().elements, files: {} } }); e2.view = t.ed.view; e2.setSize(900, 600);
  const ph = e2.displayList(THEME).filter(i => i.id === img.id);
  expect(ph.some(i => i.t === "image")).toBe(false);
  expect(ph.some(i => i.t === "path" && i.dash)).toBe(true);
});

test("SVG export embeds the image as a data URL and refuses anything that isn't one", async () => {
  const t = setup();
  t.ed.addImage(FILE, { x: 450, y: 300 });
  t.ed.sel.clear();
  const svg = toSvg(t.ed.displayList(THEME), { width: 900, height: 600, background: THEME.bg, files: t.ed.doc.files });
  expect(svg).toContain(`<image href="${PNG}"`);
  const evil = toSvg([{ t: "image", fileId: "x", x: 0, y: 0, w: 10, h: 10 }], { files: { x: { dataURL: 'javascript:alert(1)" onload="x' } } });
  expect(evil).not.toContain("javascript");
  expect(evil).not.toContain("onload");
  await t.shot("image");
});

test("rotation keeps the image's angle (SVG export turns it)", () => {
  const t = setup();
  const id = t.ed.addImage(FILE, { x: 300, y: 200 });
  t.ed.rotateBy(90);
  expect(t.ed.doc.get(id).angle).toBeCloseTo(Math.PI / 2, 5);
  const it = t.ed.displayList(THEME).find(i => i.id === id && i.t === "image");
  expect(it.angle).toBeCloseTo(Math.PI / 2, 5);
  const svg = toSvg([it], { files: t.ed.doc.files });
  expect(svg).toContain("rotate(90.00");
});
