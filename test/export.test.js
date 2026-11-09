// Export: the drawing, cropped to what's painted, as SVG at any pixel ratio (PNG is rasterized from it).
import { test, expect, afterAll } from "bun:test";
import { setup, PNG } from "./harness/fixture.js";
import { rasterize, closeRaster } from "./harness/raster.js";
import { exportScene, paintedBox, LIGHT } from "../core/export.js";
import { Doc } from "../core/doc.js";
import { emptyScene } from "../core/model.js";
import { toSvg, RASTER_FACES } from "../adapters/svg/svg.js";

const exportSvg = (doc, theme, opts) => { const s = exportScene(doc, theme, opts); return toSvg(s.items, s); };

afterAll(closeRaster);

const attrs = svg => {
  const m = /<svg[^>]*width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  return m && m.slice(1).map(Number);
};

test("export crops to everything painted: a frame's name above it, an arrow's head past its end", () => {
  const t = setup();
  t.key("f"); t.drag([100, 100], [300, 250]);   // frame name sits ~18px above y=100
  t.key("a"); t.drag([400, 300], [600, 300]);   // head reaches a little past nothing; end at x=600
  const box = paintedBox(t.ed.doc, LIGHT);
  expect(box.y).toBeLessThan(100 - 10);
  expect(box.x).toBeLessThanOrEqual(100);
  expect(box.x + box.w).toBeGreaterThanOrEqual(600);
  const svg = exportSvg(t.ed.doc, LIGHT, { padding: 20, scale: 1 });
  const [w, h, vw, vh] = attrs(svg);
  expect(vw - (box.w + 40)).toBeGreaterThanOrEqual(0); expect(vw - (box.w + 40)).toBeLessThan(1);
  expect(vh - (box.h + 40)).toBeGreaterThanOrEqual(0); expect(vh - (box.h + 40)).toBeLessThan(1);
  expect([w, h]).toEqual([vw, vh]);
});

test("scale multiplies the pixel size and keeps the drawing's units; the background covers it all", () => {
  const t = setup();
  t.key("r"); t.drag([0, 0], [100, 50]);
  const svg = exportSvg(t.ed.doc, LIGHT, { scale: 2, padding: 10 });
  const [w, h, vw, vh] = attrs(svg);
  expect(w).toBeCloseTo(vw * 2, 3); expect(h).toBeCloseTo(vh * 2, 3);
  // Not width="100%": sips sizes a percentage from the pixel size, which left most of a 2x PNG black.
  expect(svg).toContain(`<rect x="0" y="0" width="${vw}" height="${vh}" fill="#ffffff"/>`);
});

test("a huge board is scaled down to at most maxPixels on its longest side", () => {
  const t = setup();
  t.key("r"); t.drag([0, 0], [300, 100]);
  t.ed.transact(tx => { const r = tx.get(t.byType("rectangle")[0].id); r.width = 20000; });
  const [w, h] = attrs(exportSvg(t.ed.doc, LIGHT, { scale: 2, maxPixels: 4096 }));
  expect(Math.max(w, h)).toBeLessThanOrEqual(4096.01);
});

test("an empty board exports a small blank canvas, no NaN", () => {
  const svg = exportSvg(new Doc(emptyScene()), LIGHT, { scale: 2 });
  expect(svg).not.toContain("NaN");
  const [w, h] = attrs(svg);
  expect(w).toBeGreaterThan(0); expect(h).toBeGreaterThan(0);
});

test("export paints images and ignores the editor's view, selection and overlays", async () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [300, 200]);
  t.ed.addImage({ id: "f1", mimeType: "image/png", dataURL: PNG, width: 160, height: 80 }, { x: 500, y: 150 });
  t.ed.view = { x: -5000, y: 300, scale: 0.1 };   // wherever the person has scrolled to
  const svg = exportSvg(t.ed.doc, LIGHT, { scale: 2, padding: 24 });
  expect(svg).toContain(`<image href="${PNG}"`);
  const [w, h, vw, vh] = attrs(svg);
  expect(vw).toBeGreaterThan(400); expect(vw).toBeLessThan(560);
  await rasterize(svg, `${import.meta.dir}/out/export.png`, { width: Math.ceil(w), height: Math.ceil(h) });
});

test("toSvg's scale option sets pixel size only", () => {
  const svg = toSvg([], { width: 100, height: 50, scale: 3, background: "#ffffff" });
  expect(attrs(svg)).toEqual([300, 150, 100, 50]);
});

test("exports use the board's page color, with ink that reads on it", async () => {
  const { boardTheme, DARK } = await import("../core/export.js");
  expect(boardTheme({})).toMatchObject({ bg: "#ffffff", fg: LIGHT.fg });
  expect(boardTheme({ viewBackgroundColor: "#1a1b1e" })).toMatchObject({ bg: "#1a1b1e", fg: DARK.fg });
  expect(boardTheme({ viewBackgroundColor: "red; x" }).bg).toBe("#ffffff");   // a hostile value falls back
});

test("a raster export leaves out embedded SVG pictures (their links could make the rasterizer fetch files or URLs)", () => {
  const evil = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>').toString("base64");
  const items = [{ t: "image", fileId: "s", x: 0, y: 0, w: 10, h: 10 }, { t: "image", fileId: "p", x: 20, y: 0, w: 10, h: 10 }];
  const files = { s: { dataURL: evil }, p: { dataURL: PNG } };
  expect(toSvg(items, { files })).toContain(evil);                       // the SVG export keeps it: a browser's <image> loads nothing external
  const raster = toSvg(items, { files, svgImages: false });
  expect(raster).not.toContain("svg+xml");
  expect(raster).toContain(PNG);
});

test("a raster export keeps a picture only if its bytes match its declared format (no SVG dressed as PNG)", () => {
  const b64 = s => Buffer.from(s, "binary").toString("base64");
  const files = {
    png: { dataURL: PNG },
    fake: { dataURL: "data:image/png;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64") },
    jpg: { dataURL: "data:image/jpeg;base64," + b64("\xff\xd8\xff\xe0rest") },
    gif: { dataURL: "data:image/gif;base64," + b64("GIF89a....") },
    webp: { dataURL: "data:image/webp;base64," + b64("RIFF\x10\x00\x00\x00WEBPVP8 ") },
    badwebp: { dataURL: "data:image/webp;base64," + b64("RIFF\x10\x00\x00\x00WAVEfmt ") },
  };
  const items = Object.keys(files).map(fileId => ({ t: "image", fileId, x: 0, y: 0, w: 1, h: 1 }));
  const raster = toSvg(items, { files, svgImages: false });
  for (const k of ["png", "jpg", "gif", "webp"]) expect(raster).toContain(files[k].dataURL);
  for (const k of ["fake", "badwebp"]) expect(raster).not.toContain(files[k].dataURL);
  expect(toSvg(items, { files })).toContain(files.fake.dataURL);   // the SVG export doesn't sniff: a browser's <image> is safe
});

// sips (the PNG step) uses only the first family in a font-family list and falls back to sans when it
// isn't installed (checked 2026-11-08: Excalifont-first hand labels came out in Helvetica), so raster
// exports name one installed face per class.
test("raster exports name one installed face per font class; SVG exports keep the full lists", () => {
  const items = [
    { t: "text", id: "h", font: "hand", x: 0, y: 0, text: "hi", size: 20, color: "#000", align: "left" },
    { t: "text", id: "m", font: "mono", x: 0, y: 40, text: "hi", size: 20, color: "#000", align: "left" },
  ];
  const svg = toSvg(items, { width: 100, height: 100 });
  expect(svg).toContain("Excalifont, Virgil");
  const raster = toSvg(items, { width: 100, height: 100, faces: RASTER_FACES });
  expect(raster).toContain(`font-family="'Chalkboard SE'"`);
  expect(raster).toContain(`font-family="'Menlo'"`);
  expect(raster).not.toContain("Excalifont");
  expect(toSvg(items, { faces: { ...RASTER_FACES, mono: "BerkeleyMono Nerd Font" } })).toContain("BerkeleyMono Nerd Font");
});
