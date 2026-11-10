// The real Herdr adapter, driven headless: built mod + fake GPUI + synthetic mouse/keys.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { installFakes, makeCx, byId, find, textOf, canvasToSvg, THEME } from "./harness/gpui-fake.js";
import { rasterize, closeRaster } from "./harness/raster.js";

const ROOT = new URL("..", import.meta.url).pathname;
const home = mkdtempSync(`${tmpdir()}/herdr-draw-`);
const file = `${home}/board.excalidraw`;
let calls, Draw;

beforeAll(async () => {
  const b = Bun.spawnSync(["sh", `${ROOT}scripts/build.sh`]);
  if (b.exitCode) throw new Error(b.stderr.toString());
  calls = installFakes({ file, home });
  Draw = (await import(`${ROOT}build/herdr-draw/main.js`)).default;
});
afterAll(closeRaster);

async function open(size = { width: 1100, height: 700 }) {
  const cxs = makeCx(calls), cx = cxs;
  const view = new Draw();
  cxs.call(c => view.init({}, c));
  await cxs.flush();
  const ui = {
    view, cx,
    tree: () => cxs.call(c => view.render(c)).__node,
    canvas() { return byId(ui.tree(), "draw-canvas"); },
    fire(id, handler, ev) { const n = id === "canvas" ? ui.canvas() : byId(ui.tree(), id); if (!n) throw new Error(`no element ${id}`); const h = n.handlers[handler]; if (!h) throw new Error(`${id} has no ${handler}`); cxs.call(c => h(ev, c)); },
    ev: (x, y, m = {}, clicks = 1) => ({ local_position: { x, y }, modifiers: { shift: false, alt: false, control: false, platform: false, ...m }, click_count: clicks, button: "left", bounds: { x: 0, y: 0, width: 100, height: 18 } }),
    on(name, ev) { const h = ui.canvas().handlers[name]; cxs.call(c => h(ev, c)); },
    drag(from, to, m = {}, steps = 8) {
      ui.on("on_mouse_down:left", ui.ev(...from, m));
      for (let i = 1; i <= steps; i++) ui.on("on_mouse_move", ui.ev(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps, m));
      ui.on("on_mouse_up:left", ui.ev(...to, m));
    },
    dblclick(at) { ui.on("on_mouse_down:left", ui.ev(...at, {}, 2)); ui.on("on_mouse_up:left", ui.ev(...at, {}, 2)); },
    key(key, m = {}) { const h = ui.tree().handlers.on_key_down; cxs.call(c => h({ key, modifiers: { shift: false, alt: false, control: false, platform: false, ...m } }, c)); },
    input() { const n = find(ui.tree(), n => n.kind === "input"); return n && { type: t => cxs.call(c => n.state.type(t, c)), submit: (ev = { secondary: true }) => cxs.call(c => n.state.submit(c, ev)) }; },
    click(id) { ui.fire(id, "on_click", ui.ev(0, 0)); },
    async shot(name) {
      const c = ui.canvas();
      const svg = canvasToSvg(c, { width: view.size.w, height: view.size.h, bg: THEME.background, root: home });
      await rasterize(svg, `${ROOT}test/out/${name}.png`, { width: Math.round(view.size.w), height: Math.round(view.size.h) });
    },
    disk: () => JSON.parse(readFileSync(file, "utf8")),
  };
  ui.on("on_size_change", { width: size.width - 232, height: size.height - 70 });
  return ui;
}

test("toolbar click + canvas drag draws a rectangle and saves the file", async () => {
  const ui = await open();
  ui.click("tool-rectangle");
  expect(ui.view.ed.tool).toBe("rectangle");
  ui.drag([100, 100], [260, 200]);
  await ui.cx.flush();
  const rects = ui.disk().elements.filter(e => e.type === "rectangle" && !e.isDeleted);
  expect(rects.length).toBe(1);
  expect(rects[0].width).toBe(160);
});

test("leaving the pane mid-drag ends the drag (GPUI misses the release)", async () => {
  const ui = await open();
  ui.key("o");
  ui.on("on_mouse_down:left", ui.ev(300, 300));
  ui.on("on_mouse_move", ui.ev(380, 360));
  ui.on("on_hover", false);
  expect(ui.view.ed.g).toBe(null);
  // The board fits itself on open, so compare in board units.
  const w = 80 / ui.view.ed.view.scale;
  expect(ui.view.ed.doc.live().some(e => e.type === "ellipse" && Math.abs(e.width - w) < 0.01)).toBe(true);
});

test("double-click a shape, type in the input, Enter: a label", async () => {
  const ui = await open();
  ui.key("r"); ui.drag([400, 100], [560, 180]);
  ui.dblclick([480, 140]);
  const input = ui.input();
  expect(input).toBeTruthy();
  input.type("Queue");
  input.submit();
  const label = ui.view.ed.doc.live().find(e => e.type === "text" && e.text === "Queue");
  expect(label?.containerId).toBeTruthy();
});

test("typing works whether or not the text box got the keyboard", async () => {
  const ui = await open();
  ui.key("r"); ui.drag([100, 420], [240, 500]);
  ui.dblclick([170, 460]);
  // Real key events, sent where the keyboard is: the box if it took focus, else the pane.
  const send = (key, m = {}) => { const n = find(ui.tree(), n => n.kind === "input"); if (n?.state.focused) n.state.type(n.state.value() + (key === "space" ? " " : key), ui.cx.async); else ui.key(key, m); };
  for (const k of ["H", "i", "space", "y", "o"]) send(k, k === "H" ? { shift: true } : {});
  ui.key("escape");                                       // Excalidraw: Escape finishes (Enter adds a line)
  expect(ui.view.ed.doc.live().some(e => e.type === "text" && e.text === "Hi yo")).toBe(true);
  // And when it did take the keyboard after the frame:
  ui.dblclick([170, 460]);
  ui.tree(); await ui.cx.flush(1);
  expect(find(ui.tree(), n => n.kind === "input").state.focused).toBe(true);
});

test("multi-line text, Excalidraw keys: Enter adds a line; ⌘Enter or Escape finishes", async () => {
  const ui = await open();
  ui.key("t"); ui.on("on_mouse_down:left", ui.ev(300, 520)); ui.on("on_mouse_up:left", ui.ev(300, 520));
  const box = find(ui.tree(), n => n.kind === "input");
  expect(box.multiline).toBe(true);
  // Keyboard not on the box yet: the pane types into it, with the same keys.
  ui.key("a"); ui.key("enter"); ui.key("b");
  expect(ui.view.ed.text.value).toBe("a\nb");
  ui.key("enter", { platform: true });
  expect(ui.view.ed.text).toBe(null);
  expect(ui.view.ed.doc.live().some(e => e.type === "text" && e.text === "a\nb")).toBe(true);
  // Box has the keyboard: Enter (a plain submit) adds a line, ⌘Enter finishes.
  ui.key("t"); ui.on("on_mouse_down:left", ui.ev(300, 620)); ui.on("on_mouse_up:left", ui.ev(300, 620));
  ui.tree(); await ui.cx.flush(1);
  ui.input().type("x"); ui.input().submit({});
  expect(ui.view.ed.text.value).toBe("x\n");
  ui.input().type("x\ny"); ui.input().submit({ secondary: true });
  expect(ui.view.ed.doc.live().some(e => e.type === "text" && e.text === "x\ny")).toBe(true);
  ui.key("t"); ui.on("on_mouse_down:left", ui.ev(300, 520)); ui.on("on_mouse_up:left", ui.ev(300, 520));
  ui.tree(); await ui.cx.flush(1);                        // the box takes the keyboard after the frame
  ui.input().type("a\nb\nc");
  ui.key("escape");                                       // bubbles to the pane: finish
  expect(ui.view.ed.doc.live().some(e => e.type === "text" && e.text === "a\nb\nc")).toBe(true);
});

test("opening a board never zooms past 100%", async () => {
  const ui = await open();
  expect(ui.view.ed.view.scale).toBeLessThanOrEqual(1);
});

test("properties panel: a fill swatch fills the selection; layer panel adds and hides a layer", async () => {
  const ui = await open();
  ui.key("r"); ui.drag([100, 300], [200, 380]);
  ui.click("fi-3");
  const sel = ui.view.ed.selected()[0];
  expect(sel.backgroundColor).toBe("#a5d8ff");
  ui.click("ly-add");
  expect(ui.view.ed.doc.layers.length).toBe(2);
  const base = ui.view.ed.doc.layers[0].id;
  ui.click(`lv-${base}`);
  expect(ui.view.ed.doc.layer(base).visible).toBe(false);
  ui.click(`lv-${base}`);
});

test("cmd-c puts Excalidraw clipboard JSON on the system clipboard", async () => {
  const ui = await open();
  ui.key("r"); ui.drag([600, 300], [700, 380]);
  ui.key("c", { platform: true });
  const pb = calls.exec.find(c => String(c[2]).includes("pbcopy"));
  expect(JSON.parse(pb[4]).type).toBe("excalidraw/clipboard");
});

test("an agent's write to the file merges in (newer versions win)", async () => {
  const ui = await open();
  const disk = ui.disk();
  const r = disk.elements.find(e => e.type === "rectangle" && !e.isDeleted);
  r.x += 500; r.version += 5;
  writeFileSync(file, JSON.stringify(disk));
  ui.view.store.absorb(readFileSync(file, "utf8"), ui.cx.async);
  expect(ui.view.ed.doc.get(r.id).x).toBe(r.x);
});

test("timeline: animate + play ticks with timer.every and shows the bar", async () => {
  const ui = await open();
  ui.key("a", { platform: true });
  ui.click("an-rise");
  expect(byId(ui.tree(), "draw-timeline")).toBeTruthy();
  ui.click("tl-play");
  expect(ui.view.tick).toBeTruthy();
  await ui.cx.flush(1);
  ui.key("escape");
});

test("screenshot of the adapter's own canvas output", async () => {
  const ui = await open();
  ui.key("escape");
  ui.key("a", { platform: true }); ui.key("backspace");
  ui.key("r"); ui.drag([60, 80], [220, 160]); ui.dblclick([140, 120]);
  ui.input().type("Browser"); ui.input().submit();
  ui.key("d"); ui.drag([320, 60], [480, 180]);
  ui.key("o"); ui.drag([580, 80], [740, 160]); ui.click("fi-4");
  ui.key("a"); ui.drag([140, 120], [400, 120]);
  ui.key("a"); ui.drag([400, 120], [660, 120]);
  ui.key("p"); ui.drag([100, 300], [400, 420], {}, 30);
  ui.key("escape"); ui.drag([20, 20], [800, 220]);
  await ui.shot("herdr-canvas");
  expect(find(ui.canvas(), n => n.kind === "path")).toBeTruthy();
  expect(textOf(ui.canvas())).toContain("Browser");
});

// ── images ─────────────────────────────────────────────────────────────────
const TINY = `${ROOT}test/fixtures/tiny.png`;
const IMG_DIR = `${home}/.cache/herdr-draw/img`;
// Let the image shell scripts really run (sips, shasum, base64); everything else stays recorded only.
const realImages = () => { calls.real = (cmd, args) => ["mkdir", "test", "rm", "stat", "cat"].includes(cmd) || (cmd === "sh" && ["img-import", "img-cache", "big-write", "png-export"].includes(args[2])) || (cmd === "perl" && args[3] === "big-read"); };

test("dropping a PNG puts it on the board, cached where image() can load it, and saved in the file", async () => {
  realImages();
  const ui = await open();
  ui.key("a", { platform: true }); ui.key("backspace");
  ui.on("on_drop", { paths: [TINY] });
  await ui.cx.flush();
  const img = ui.view.ed.doc.visible().find(e => e.type === "image");
  const sha = new Bun.CryptoHasher("sha1").update(readFileSync(TINY)).digest("hex");
  expect(img.fileId).toBe(sha);
  expect([img.width, img.height]).toEqual([8, 4]);   // natural size, from sips
  expect(readFileSync(`${IMG_DIR}/${sha}.png`).equals(readFileSync(TINY))).toBe(true);
  const node = find(ui.canvas(), n => n.kind === "image");
  expect(node.path).toBe(`.cache/herdr-draw/img/${sha}.png`);
  await ui.cx.flush();   // the save timer
  expect(ui.disk().files[sha].dataURL).toStartWith("data:image/png;base64,iVBOR");
});

test("dropping something that isn't an image says so and adds nothing", async () => {
  const ui = await open();
  const n = ui.view.ed.doc.live().length;
  ui.on("on_drop", { paths: ["/tmp/notes.txt"] });
  expect(ui.view.ed.doc.live().length).toBe(n);
  expect(textOf(ui.tree())).toContain("drop images or .excalidrawlib");
});

test("an image written by someone else (drawh, a peer) is decoded into the cache and shown", async () => {
  realImages();
  const b64 = readFileSync(TINY).toString("base64");
  const scene = { type: "excalidraw", version: 2, elements: [
    { id: "pic", type: "image", fileId: "agent/../pic", x: 100, y: 100, width: 320, height: 160, angle: 0, opacity: 100, version: 3, versionNonce: 1, isDeleted: false, strokeColor: "transparent", backgroundColor: "transparent", customData: { layer: "base", z: 1 } },
    { id: "r1", type: "rectangle", x: 380, y: 140, width: 120, height: 80, angle: 0, opacity: 100, version: 3, versionNonce: 1, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeWidth: 2, roughness: 1, seed: 5, customData: { layer: "base", z: 2 } },
  ], appState: {}, files: { "agent/../pic": { id: "agent/../pic", mimeType: "image/png", dataURL: `data:image/png;base64,${b64}` } } };
  writeFileSync(file, JSON.stringify(scene));
  const ui = await open();
  ui.tree(); await ui.cx.flush();          // render asks for the decode; the spawn runs it
  const node = find(ui.canvas(), n => n.kind === "image");
  // Named by the bytes' hash, not the board's id: an id can neither climb out of the cache nor alias another picture.
  expect(node.path).toBe(`.cache/herdr-draw/img/${new Bun.CryptoHasher("sha1").update(readFileSync(TINY)).digest("hex")}.png`);
  expect(readFileSync(`${home}/${node.path}`).equals(readFileSync(TINY))).toBe(true);
  expect(readdirSync(IMG_DIR).filter(f => /\.b64|\.bin/.test(f))).toEqual([]);   // temp files are gone
  await ui.shot("herdr-image");
});

test("a board over 1 MiB (a few photos) opens, saves, and still takes an agent's write", async () => {
  realImages();
  // ~2.4 MB of base64: past readTextFile's 1 MiB, inside exec's 8 MiB. Labels in UTF-8 too.
  const big = Buffer.alloc(1_800_000, 7).toString("base64");
  const scene = { type: "excalidraw", version: 2, elements: [
    { id: "photo", type: "image", fileId: "bigpic", x: 0, y: 0, width: 300, height: 200, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "transparent", backgroundColor: "transparent", customData: { layer: "base", z: 1 } },
    { id: "t1", type: "text", text: "café ✓ 日本 🎨", x: 0, y: 260, width: 200, height: 25, fontSize: 20, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", customData: { layer: "base", z: 2 } },
  ], appState: {}, files: { bigpic: { id: "bigpic", mimeType: "image/png", dataURL: `data:image/png;base64,${big}` } } };
  writeFileSync(file, JSON.stringify(scene));
  const ui = await open();
  expect(ui.view.error).toBeNull();
  expect(ui.view.ed.doc.get("t1").text).toBe("café ✓ 日本 🎨");
  // An edit saves the whole board back through the big path.
  ui.key("r"); ui.drag([500, 300], [600, 380]);
  await ui.cx.flush();
  const disk = ui.disk();
  expect(disk.elements.some(e => e.type === "rectangle")).toBe(true);
  expect(disk.files.bigpic.dataURL.length).toBe(big.length + 22);
  expect(disk.elements.find(e => e.id === "t1").text).toBe("café ✓ 日本 🎨");
  expect(readdirSync(`${home}/.cache/herdr-draw/tmp`)).toEqual([]);          // parts cleaned up
  expect(calls.exec.some(c => c[0] === "cat" && c[1] === file)).toBe(true);   // read past 1 MiB
  expect(calls.exec.some(c => c[0] === "sh" && c[3] === "big-write")).toBe(true);
  // An agent writes meanwhile: the next save finds the file stale, merges, and keeps both.
  const theirs = ui.disk(); theirs.elements.find(e => e.id === "t1").x = 900; theirs.elements.find(e => e.id === "t1").version = 50;
  writeFileSync(file, JSON.stringify(theirs));
  ui.key("o"); ui.drag([700, 300], [780, 380]);
  await ui.cx.flush();
  const after = ui.disk();
  expect(after.elements.find(e => e.id === "t1").x).toBe(900);
  expect(after.elements.some(e => e.type === "ellipse")).toBe(true);
});

test("a board over 8 MiB (exec's output cap) opens and saves, UTF-8 intact across its parts", async () => {
  realImages();
  const big = Buffer.alloc(7_200_000, 9).toString("base64");                 // ~9.6 MB of base64
  // Multi-byte text all through the file, so some lands on every part boundary.
  const texts = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, type: "text", text: `é✓日本🎨 ${i} `.repeat(40), x: 0, y: i * 30, width: 200, height: 25, fontSize: 20, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", customData: { layer: "base", z: 2 + i } }));
  const scene = { type: "excalidraw", version: 2, elements: [
    { id: "photo", type: "image", fileId: "bigpic", x: 0, y: 0, width: 300, height: 200, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "transparent", backgroundColor: "transparent", customData: { layer: "base", z: 1 } },
    ...texts,
  ], appState: {}, files: { bigpic: { id: "bigpic", mimeType: "image/png", dataURL: `data:image/png;base64,${big}` } } };
  writeFileSync(file, JSON.stringify(scene));
  expect(readFileSync(file).length).toBeGreaterThan(8 * 1024 * 1024);
  const ui = await open();
  expect(ui.view.error).toBeNull();
  for (const t of texts) expect(ui.view.ed.doc.get(t.id).text).toBe(t.text);
  expect(ui.view.ed.doc.files.bigpic.dataURL.length).toBe(big.length + 22);
  expect(readdirSync(`${home}/.cache/herdr-draw/tmp`)).toEqual([]);          // read parts cleaned up
  ui.key("r"); ui.drag([500, 300], [600, 380]);
  await ui.cx.flush();
  const disk = ui.disk();
  expect(disk.elements.some(e => e.type === "rectangle")).toBe(true);
  expect(disk.elements.find(e => e.id === "t399").text).toBe(texts[399].text);
});

test("a board can't make another board's cached picture show by claiming its id", async () => {
  realImages();
  const sha = new Bun.CryptoHasher("sha1").update(readFileSync(TINY)).digest("hex");   // already cached by the tests above
  const other = Buffer.from(readFileSync(TINY)); other[other.length - 20] ^= 1;       // different bytes
  const scene = { type: "excalidraw", version: 2, elements: [
    { id: "spoof", type: "image", fileId: sha, x: 0, y: 0, width: 80, height: 40, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "transparent", backgroundColor: "transparent", customData: { layer: "base", z: 1 } },
  ], appState: {}, files: { [sha]: { id: sha, mimeType: "image/png", dataURL: `data:image/png;base64,${other.toString("base64")}` } } };
  writeFileSync(file, JSON.stringify(scene));
  const ui = await open();
  ui.tree(); await ui.cx.flush();
  const node = find(ui.canvas(), n => n.kind === "image");
  expect(node.path).not.toContain(sha);
  expect(readFileSync(`${home}/${node.path}`).equals(other)).toBe(true);
});

test("SVG export (⌘⇧E) of a photo board passes 1 MiB and still writes, picture included", async () => {
  realImages();
  const big = Buffer.alloc(1_200_000, 9).toString("base64");
  const scene = { type: "excalidraw", version: 2, elements: [
    { id: "p", type: "image", fileId: "bp", x: 0, y: 0, width: 300, height: 200, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, strokeColor: "transparent", backgroundColor: "transparent", customData: { layer: "base", z: 1 } },
  ], appState: {}, files: { bp: { id: "bp", mimeType: "image/png", dataURL: `data:image/png;base64,${big}` } } };
  writeFileSync(file, JSON.stringify(scene));
  const svgPath = file.replace(/\.excalidraw$/, ".svg");
  writeFileSync(svgPath, "x".repeat(1_500_000));   // an earlier big export is already there
  const ui = await open();
  ui.key("e", { platform: true, shift: true });
  await ui.cx.flush(); await new Promise(r => setTimeout(r, 50));
  const out = readFileSync(svgPath, "utf8");
  expect(ui.view.error).toBeNull();
  expect(out).toContain(`<image href="data:image/png;base64,${big.slice(0, 40)}`);
});

test("⌘⇧E writes board.svg and a 2x board.png beside the board, cropped to the drawing", async () => {
  realImages();
  writeFileSync(file, JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
  const ui = await open();
  ui.key("r"); ui.drag([100, 100], [300, 200]);
  ui.on("on_drop", { paths: [TINY] }); await ui.cx.flush();
  ui.key("e", { platform: true, shift: true });
  await ui.cx.flush(); await new Promise(r => setTimeout(r, 300)); await ui.cx.flush();
  const base = file.replace(/\.excalidraw$/, "");
  const svg = readFileSync(`${base}.svg`, "utf8");
  const [, vw, vh] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg).map(Number);
  expect(svg).toContain('fill="#ffffff"');                         // the board's page, not the pane's dark theme
  const dims = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", `${base}.png`]).stdout.toString();
  expect(+/pixelWidth: (\d+)/.exec(dims)[1]).toBe(vw * 2);
  expect(+/pixelHeight: (\d+)/.exec(dims)[1]).toBe(vh * 2);
  expect(textOf(ui.tree())).toContain("exported board.svg + .png");
  expect(readdirSync(`${home}/.cache/herdr-draw/tmp`)).toEqual([]);   // the 2x SVG is gone
  Bun.spawnSync(["cp", `${base}.png`, `${ROOT}test/out/herdr-export.png`]);
});

// ── library ────────────────────────────────────────────────────────────────
const LIB = `${home}/herdr-draw/library.excalidrawlib`;
const libItem = (id, name, x = 0) => ({ id, status: "unpublished", created: 1, name, elements: [
  { id: `${id}-r`, type: "rectangle", x, y: 0, width: 120, height: 60, angle: 0, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", strokeWidth: 2, roughness: 1, seed: 3, boundElements: [{ id: `${id}-t`, type: "text" }] },
  { id: `${id}-t`, type: "text", text: name, x, y: 20, width: 80, height: 25, fontSize: 20, angle: 0, version: 1, versionNonce: 1, isDeleted: false, containerId: `${id}-r`, strokeColor: "#1e1e1e" },
] });

test("library panel: lists items with a drawn preview; a click inserts one into the board", async () => {
  realImages();
  Bun.spawnSync(["mkdir", "-p", `${home}/herdr-draw`]);
  writeFileSync(LIB, JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: [libItem("db", "Database"), libItem("q", "Queue")] }));
  writeFileSync(file, JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
  const ui = await open();
  await ui.cx.flush();
  const tile = byId(ui.tree(), "lib-db");
  expect(textOf(tile)).toContain("Database");
  expect(find(tile, n => n.kind === "path")).toBeTruthy();                 // a little drawing, not just a name
  expect(textOf(ui.tree())).toContain("LIBRARY · 2");
  ui.click("lib-db");
  const ed = ui.view.ed;
  expect(ed.doc.live().map(e => e.type).sort()).toEqual(["rectangle", "text"]);
  expect(ed.doc.live().find(e => e.type === "text").text).toBe("Database");
  await ui.cx.flush();
  expect(ui.disk().elements.filter(e => !e.isDeleted).length).toBe(2);       // saved like any edit
});

test("+ saves the selection to the library file (big pictures too); ✕ removes it", async () => {
  realImages();
  const big = Buffer.alloc(700_000, 3).toString("base64");                    // the library passes 900 KB: io.js's big path
  writeFileSync(file, JSON.stringify({ type: "excalidraw", version: 2, appState: {}, elements: [
    { id: "pic", type: "image", fileId: "bigpic", x: 0, y: 0, width: 200, height: 100, angle: 0, opacity: 100, version: 2, versionNonce: 1, isDeleted: false, customData: { layer: "base", z: 1 } },
  ], files: { bigpic: { id: "bigpic", mimeType: "image/png", dataURL: `data:image/png;base64,${big}` } } }));
  const ui = await open();
  await ui.cx.flush();
  const before = calls.exec.length;
  ui.view.ed.select(["pic"]);
  ui.click("lib-add");
  await ui.cx.flush();
  const lib = JSON.parse(readFileSync(LIB, "utf8"));
  expect(lib.libraryItems.length).toBe(3);
  expect(lib.libraryItems[0].files.bigpic.dataURL.length).toBe(big.length + 22);
  expect(calls.exec.slice(before).some(c => c[0] === "sh" && c[3] === "big-write")).toBe(true);
  expect(textOf(ui.tree())).toContain("LIBRARY · 3");
  const id = lib.libraryItems[0].id;
  ui.fire(`lib-rm-${id}`, "on_click", ui.ev(0, 0));
  await ui.cx.flush();
  expect(JSON.parse(readFileSync(LIB, "utf8")).libraryItems.map(i => i.id)).not.toContain(id);
});

test("dropping a .excalidrawlib adds its items once, however often it's dropped", async () => {
  realImages();
  const drop = `${home}/shared.excalidrawlib`;
  writeFileSync(drop, JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: [libItem("cache", "Cache"), libItem("db", "Database")] }));
  const ui = await open();
  await ui.cx.flush();
  const n = JSON.parse(readFileSync(LIB, "utf8")).libraryItems.length;
  ui.on("on_drop", { paths: [drop] }); await ui.cx.flush();
  ui.on("on_drop", { paths: [drop] }); await ui.cx.flush();
  const ids = JSON.parse(readFileSync(LIB, "utf8")).libraryItems.map(i => i.id);
  expect(ids.length).toBe(n + 1);                                            // "db" was already there; "cache" is new
  expect(ids[0]).toBe("cache");
  expect(textOf(ui.tree())).toContain("library: 0 items added");             // the second drop
  await ui.shot("herdr-library");
});

test("? opens every shortcut, Esc closes it; tools and panels show their keys", async () => {
  const ui = await open();
  await ui.cx.flush();
  expect(textOf(byId(ui.tree(), "tool-rectangle"))).toContain("R");             // badge beside the icon
  expect(textOf(byId(ui.tree(), "lock"))).toContain("Q");
  expect(textOf(byId(ui.tree(), "draw-side"))).toContain("Stroke");
  expect(textOf(byId(ui.tree(), "draw-side"))).toMatch(/StrokeC/);              // the row's key after its label
  ui.key("/", { shift: true });                                                 // how GPUI reports "?"
  const help = byId(ui.tree(), "help-overlay");
  expect(help).toBeTruthy();
  expect(textOf(help)).toContain("Shortcuts");
  expect(textOf(help)).toContain("Distribute across, down");
  ui.key("r");                                                                  // swallowed while it's open
  expect(ui.view.ed.tool).toBe("select");
  ui.key("escape");
  expect(byId(ui.tree(), "help-overlay")).toBe(null);
  ui.click("help");                                                             // the toolbar's ? button
  expect(byId(ui.tree(), "help-overlay")).toBeTruthy();
  ui.fire("help-overlay", "on_mouse_down:left", ui.ev(5, 5));                           // a click outside the card
  expect(byId(ui.tree(), "help-overlay")).toBe(null);
});

test("the demo plays in its own editor and never touches the person's board", async () => {
  const ui = await open();
  await ui.cx.flush();
  ui.click("tool-rectangle"); ui.drag([60, 60], [140, 120]);
  await ui.cx.flush();
  const mine = ui.view.ed, disk = readFileSync(file, "utf8");
  ui.key("/", { shift: true }); ui.key("d");                                    // D in the help list
  expect(ui.view.board).toBe(mine);
  expect(ui.view.ed).not.toBe(mine);
  expect(ui.view.ed.play).toBeTruthy();
  expect(byId(ui.tree(), "demo-bar")).toBeTruthy();
  expect(byId(ui.tree(), "draw-timeline")).toBeTruthy();
  ui.key("r"); ui.drag([300, 300], [400, 380]);                                 // play with it
  await ui.cx.flush();
  expect(readFileSync(file, "utf8")).toBe(disk);                                // nothing saved
  ui.key("e", { platform: true, shift: true });                                 // export is refused, not the demo written over the board's export
  expect(textOf(ui.tree())).toContain("the demo isn't saved");
  ui.key("escape");                                                             // Esc: back (also cancels the rectangle tool's nothing)
  expect(ui.view.ed).toBe(mine);
  expect(ui.view.board).toBe(null);
  expect(byId(ui.tree(), "demo-bar")).toBe(null);
  ui.key("r"); ui.drag([200, 200], [260, 250]);
  await ui.cx.flush();
  expect(readFileSync(file, "utf8")).not.toBe(disk);                            // saving works again
});

test("the canvas cursor follows the editor: crosshair to draw, pointer on a connection point", async () => {
  const ui = await open();
  await ui.cx.flush();
  ui.click("tool-rectangle"); ui.drag([400, 300], [520, 380]);
  ui.click("tool-arrow");
  ui.on("on_mouse_move", ui.ev(80, 80));
  expect(ui.canvas().style.cursor_crosshair).toBe(true);
  ui.on("on_mouse_move", ui.ev(460, 300));                                     // the box's top connection point
  expect(ui.canvas().style.cursor_pointer).toBe(true);
  ui.view.ed.setTool("hand");
  expect(ui.canvas().style.cursor_grab).toBe(true);
});

test("rotated text shows turned: sips draws it as a picture, upright text needs none", async () => {
  calls.real = (cmd, args) => cmd === "sh" && ["txt-raster", "txt-reset"].includes(args[2]);
  const ui = await open();
  await ui.cx.flush();
  const before = calls.exec.length;
  ui.click("tool-text"); ui.on("on_mouse_down:left", ui.ev(200, 200)); ui.on("on_mouse_up:left", ui.ev(200, 200));
  ui.input().type("Turned"); ui.input().submit();
  const id = [...ui.view.ed.sel][0] ?? ui.view.ed.doc.live().filter(e => e.type === "text").at(-1).id;
  ui.tree(); await ui.cx.flush();
  expect(calls.exec.slice(before).some(c => c[3] === "txt-raster")).toBe(false);          // upright: plain text
  ui.view.ed.select([id]); ui.view.ed.rotateBy(30);
  ui.tree(); await ui.cx.flush(); ui.tree(); await ui.cx.flush();
  const job = calls.exec.slice(before).find(c => c[3] === "txt-raster");
  expect(job).toBeTruthy();
  expect(existsSync(job[4])).toBe(false);                                                  // the SVG is gone after sips
  const png = readFileSync(job[5]);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  const pic = find(ui.canvas(), n => n.kind === "image" && String(n.path).includes(".cache/herdr-draw/txt/"));
  expect(pic).toBeTruthy();                                                                   // drawn as the picture, not upright text
  expect(textOf(ui.canvas())).not.toContain("Turned");
  calls.real = null;
}, 20000);

test("⌘O picks another board: filter, switch (saving the one left first), and a new one by name", async () => {
  realImages(); const big = calls.real;   // earlier tests leave a big board: its save goes through the shell
  calls.real = (cmd, args) => big(cmd, args) || cmd === "find" || (cmd === "sh" && args[2] === "write-small");
  mkdirSync(`${home}/boards`, { recursive: true });
  writeFileSync(`${home}/boards/Roadmap.excalidraw`, JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "rm1", type: "rectangle", x: 0, y: 0, width: 50, height: 40, version: 1, versionNonce: 1, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeWidth: 2, roughness: 1, opacity: 100, seed: 1, angle: 0 }] }));
  const ui = await open();
  await ui.cx.flush();
  ui.click("tool-rectangle"); ui.drag([60, 60], [140, 120]);                  // an edit not saved yet (250 ms timer)
  const drawn = [...ui.view.ed.sel][0];
  ui.key("o", { platform: true });
  expect(byId(ui.tree(), "picker")).toBeTruthy();
  await ui.cx.flush(); await ui.cx.flush();
  ui.key("r");                                                               // typing goes to the search, not the tools
  expect(ui.view.ed.tool).toBe("select");
  ui.view.pickInput.set_value("road"); ui.view.picker.query = "road"; ui.view.rankPicker();
  expect(ui.view.picker.rows[0].name).toBe("Roadmap");
  ui.tree(); await ui.cx.flush(); await ui.cx.flush();                         // the preview loads after the frame
  const pv = [...ui.view.pv.entries()].find(([k]) => k.startsWith(`${home}/boards/Roadmap.excalidraw|`))?.[1];
  expect(pv?.layers?.length).toBeGreaterThan(0);
  expect(textOf(byId(ui.tree(), "picker"))).not.toContain("…");
  ui.key("enter");
  await ui.cx.flush(); await ui.cx.flush();
  expect(ui.view.file).toBe(`${home}/boards/Roadmap.excalidraw`);
  expect(byId(ui.tree(), "picker")).toBe(null);
  expect(JSON.parse(readFileSync(file, "utf8")).elements.some(e => e.id === drawn && !e.isDeleted)).toBe(true);   // the board left was saved first
  expect(ui.view.ed.doc.live().map(e => e.id)).toEqual(["rm1"]);
  expect(JSON.parse(readFileSync(`${home}/herdr-draw/recent.json`, "utf8"))[0]).toBe(`${home}/boards/Roadmap.excalidraw`);
  // A new one: type a name, ⌘Enter.
  ui.click("board-name");
  ui.view.pickInput.set_value("Sprint plan"); ui.view.picker.query = "Sprint plan"; ui.view.rankPicker();
  expect(ui.view.picker.rows.at(-1).create).toBe(true);
  ui.key("enter", { platform: true });
  await ui.cx.flush(); await ui.cx.flush();
  expect(ui.view.file).toBe(`${home}/boards/Sprint plan.excalidraw`);
  expect(existsSync(`${home}/boards/Sprint plan.excalidraw`)).toBe(true);
  expect(ui.view.ed.doc.live().length).toBe(0);
  calls.real = null;
});

test("with the person's keys.json, labels and help show ⌃ for the ⌘ keys Herdr takes, and ⌃ works", async () => {
  // Like the person's: their Herdr gives these ⌘ keys to agents, splits and lazygit.
  writeFileSync(`${home}/keys.json`, JSON.stringify({ global: { "cmd-a": "agent.next", "cmd-d": "pane.split:right", "cmd-[": "agent.prev", "cmd-]": "agent.next", "cmd-shift-l": "x" } }));
  const ui = await open();
  await ui.cx.flush(); await ui.cx.flush();
  ui.click("tool-rectangle"); ui.drag([300, 300], [380, 360]);
  const side = textOf(byId(ui.tree(), "draw-side"));
  expect(side).toContain("⌃D");                                              // duplicate chip
  expect(side).toContain("⌃]");
  expect(side).toContain("⌃⇧L");
  expect(side).toContain("⌘G");                                              // not taken here: stays ⌘
  ui.key("/", { shift: true });
  const help = textOf(byId(ui.tree(), "help-overlay"));
  expect(help).toContain("⌃A");
  expect(help).toContain("your Herdr keys");
  ui.key("escape");
  const before = calls.exec.length;
  ui.key("c", { control: true });                                            // ⌃C copies like ⌘C
  expect(calls.exec.slice(before).some(c => c[0] === "sh" && c[3] === "copy")).toBe(true);
  const n = ui.view.ed.doc.live().length;
  ui.key("d", { control: true });                                            // ⌃D duplicates
  expect(ui.view.ed.doc.live().length).toBeGreaterThan(n);
  writeFileSync(`${home}/keys.json`, "{}");
});

// ── the side panel: one layout for every board pane (panel.json) ──────────────────────────────
const panelStore = () => import(`${ROOT}build/herdr-draw/panel-store.js`);
const freshPanel = async () => { rmSync(`${home}/herdr-draw/panel.json`, { force: true }); (await panelStore()).resetPanelStore(); };
const sectionIds = ui => (byId(ui.tree(), "side-scroll")?.children ?? []).map(n => n.style?.id).filter(Boolean);
const rootFire = (ui, handler, ev) => { const h = ui.tree().handlers[handler]; ui.cx.call(c => h(ev, c)); };
const at = (x, y = 300) => ({ position: { x, y }, local_position: { x: 0, y: 0 }, modifiers: {}, button: "left" });

test("panel: drag its left edge to resize; the width is saved for every board pane", async () => {
  await freshPanel();
  const ui = await open();
  expect(byId(ui.tree(), "draw-side").style.w).toBe(232);
  ui.fire("side-edge", "on_mouse_down:left", at(868));
  rootFire(ui, "on_mouse_move", at(800));
  rootFire(ui, "on_mouse_move", at(768));
  expect(byId(ui.tree(), "draw-side").style.w).toBe(332);
  rootFire(ui, "on_mouse_up:left", at(768));
  await ui.cx.flush();
  expect(JSON.parse(readFileSync(`${home}/herdr-draw/panel.json`, "utf8")).width).toBe(332);
  rootFire(ui, "on_mouse_move", at(500));                                   // drag over: moving no longer resizes
  expect(byId(ui.tree(), "draw-side").style.w).toBe(332);
  // Another board pane draws the same panel, and the board keeps its room in a narrow pane.
  const other = await open({ width: 1100, height: 700 });
  expect(byId(other.tree(), "draw-side").style.w).toBe(332);
  other.on("on_size_change", { width: 118, height: 600 });                  // a 450 px pane (118 + the 332 panel)
  expect(byId(other.tree(), "draw-side").style.w).toBe(250);                // the board keeps 200
  other.on("on_size_change", { width: 100, height: 600 });                  // a 350 px pane: no room, hidden
  expect(byId(other.tree(), "draw-side")).toBe(null);
  await freshPanel();
});

test("panel: click a title to fold it; drag a title onto another to move it; leaving the pane ends a drag", async () => {
  await freshPanel();
  const ui = await open();
  ui.click("tool-rectangle"); ui.drag([300, 300], [380, 360]);              // a selection: Arrange shows
  expect(sectionIds(ui).slice(0, 2)).toEqual(["sec-properties", "sec-arrange"]);
  ui.fire("sec-head-properties", "on_mouse_down:left", at(900));
  ui.fire("sec-head-properties", "on_mouse_up:left", at(900));
  rootFire(ui, "on_mouse_up:left", at(900));
  expect(textOf(byId(ui.tree(), "sec-properties"))).not.toContain("Stroke");
  expect(textOf(byId(ui.tree(), "sec-head-properties"))).toContain("▸");
  ui.fire("sec-head-properties", "on_mouse_down:left", at(900));             // and back
  ui.fire("sec-head-properties", "on_mouse_up:left", at(900));
  rootFire(ui, "on_mouse_up:left", at(900));
  expect(textOf(byId(ui.tree(), "sec-properties"))).toContain("Stroke");
  // Drag Library's title up over Animate and then Arrange.
  ui.fire("sec-head-library", "on_mouse_down:left", at(900));
  ui.fire("sec-head-animate", "on_mouse_move", at(900));
  ui.fire("sec-head-arrange", "on_mouse_move", at(900));
  ui.fire("sec-head-arrange", "on_mouse_up:left", at(900));                  // a drag, not a click: Arrange stays open
  rootFire(ui, "on_hover", false);
  expect(sectionIds(ui).slice(0, 3)).toEqual(["sec-properties", "sec-library", "sec-arrange"]);
  expect(textOf(byId(ui.tree(), "sec-arrange"))).toContain("▾");
  await ui.cx.flush();
  expect(JSON.parse(readFileSync(`${home}/herdr-draw/panel.json`, "utf8")).order.slice(0, 3)).toEqual(["properties", "library", "arrange"]);
  await freshPanel();
});

test("panel: tabs show one section at a time; ⚙ hides, reorders and resets sections", async () => {
  await freshPanel();
  const ui = await open();
  ui.click("side-mode");
  expect(sectionIds(ui)).toEqual(["sec-properties"]);
  expect(textOf(byId(ui.tree(), "sec-properties"))).toContain("PROPERTIES · NEXT SHAPE");   // the live title stays
  ui.click("tab-layers");
  expect(sectionIds(ui)).toEqual(["sec-layers"]);
  expect(byId(ui.tree(), "tab-arrange")).toBe(null);                         // nothing selected: no Arrange tab
  ui.click("side-mode");                                                     // back to stacked
  ui.click("side-gear");
  expect(textOf(byId(ui.tree(), "panel-settings"))).toContain("Library");
  ui.click("ps-show-animate");                                               // hide Animate
  ui.click("ps-up-layers");                                                  // Layers above Animate's slot
  ui.click("ps-show-properties");                                            // Properties can't be hidden
  ui.click("side-gear");
  const ids = sectionIds(ui);
  expect(ids).not.toContain("sec-animate");
  expect(ids).toContain("sec-properties");
  expect(ids.indexOf("sec-layers")).toBeLessThan(ids.indexOf("sec-library"));
  ui.click("side-gear"); ui.click("ps-reset"); ui.click("side-gear");
  expect(sectionIds(ui)).toContain("sec-animate");
  await freshPanel();
});

// ── a board on another machine (a space's `machine`): read, written and polled through exec's `on` ──
test("a board on another machine opens, saves, picks up an agent's writes, and shows in the picker", async () => {
  const dir = mkdtempSync(`${tmpdir()}/herdr-draw-ska-`), rf = `${dir}/journeys.excalidraw`;
  const drawh = (...a) => { const r = Bun.spawnSync([`${ROOT}cli/drawh`, ...a]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  drawh("add", rf, "rect", "--at", "0,0", "--label", "Search");
  const was = { props: calls.props, machines: calls.machines, spaces: calls.spaces, real: calls.real, cwd: calls.cwd };
  calls.props = { file: rf, machine: "ska" };
  calls.machines = [{ name: null, layout: "ready" }, { name: "ska", layout: "ready" }];
  calls.real = cmd => ["sh", "find", "mkdir", "rm"].includes(cmd);
  calls.remote = [];
  try {
    const ui = await open();
    await ui.cx.flush();
    expect(ui.view.machine).toBe("ska");
    expect(ui.view.ed.doc.live().some(e => e.text === "Search")).toBe(true);
    expect(calls.remote.some(c => c[0] === "ska" && c[4] === "board-read")).toBe(true);
    expect(textOf(byId(ui.tree(), "board-name") ?? ui.tree())).toContain("ska · journeys");
    // An edit here is saved there: parts into a temp file, renamed over the board if it's unchanged.
    ui.click("tool-rectangle"); ui.drag([300, 300], [420, 380]);
    await ui.cx.flush();
    const disk = () => JSON.parse(readFileSync(rf, "utf8")).elements.filter(e => !e.isDeleted);
    expect(disk().filter(e => e.type === "rectangle").length).toBe(2);
    expect(calls.remote.some(c => c[4] === "board-commit")).toBe(true);
    expect(readdirSync(dir).filter(f => f.includes(".herdr-"))).toEqual([]);              // no temp files left
    // The agent there writes: the pane's poll sees the new stamp and takes it in.
    drawh("add", rf, "rect", "--at", "0,300", "--label", "Pay");
    await ui.cx.flush();
    expect(ui.view.ed.doc.live().some(e => e.text === "Pay")).toBe(true);
    // Both write at once: the pane's save finds the board changed, merges, and keeps both.
    drawh("add", rf, "rect", "--at", "0,600", "--label", "Confirm");
    ui.click("tool-ellipse"); ui.drag([500, 300], [560, 360]);
    await ui.cx.flush(); await ui.cx.flush();
    expect(disk().some(e => e.text === "Confirm")).toBe(true);
    expect(disk().some(e => e.type === "ellipse")).toBe(true);
    // In a space on that machine, ⌘O lists that machine's boards, marked with its name.
    calls.spaces = [{ id: "s1", machine: "ska" }]; calls.cwd = dir;
    ui.key("o", { platform: true });
    await ui.cx.flush();
    const row = ui.view.picker.rows.find(r => r.path === `ska:${rf}`);
    expect(row).toBeTruthy();
    expect(row.folder.startsWith("ska: ")).toBe(true);
    ui.key("escape");
  } finally { Object.assign(calls, was); calls.remote = []; }
});

test("the same pane drawn by that machine's own Herdr (which doesn't list itself) reads the file locally", async () => {
  const was = calls.props;
  calls.props = { file, machine: "ska" };            // machines(): only this computer
  try {
    const ui = await open();
    expect(ui.view.machine).toBe(null);
  } finally { calls.props = was; }
});

test("a pane made on another machine (only a path in its props) finds its board there", async () => {
  const dir = mkdtempSync(`${tmpdir()}/herdr-draw-ska-`), rf = `${dir}/made-there.excalidraw`;
  const r = Bun.spawnSync([`${ROOT}cli/drawh`, "add", rf, "rect", "--at", "0,0", "--label", "There"]); if (r.exitCode) throw new Error(r.stderr.toString());
  const was = { props: calls.props, machines: calls.machines, real: calls.real, hook: calls.hook };
  calls.props = { file: rf };                                            // what drawh open on ska writes
  calls.machines = [{ name: null, layout: "ready" }, { name: "ska", layout: "ready" }];
  calls.real = cmd => ["sh"].includes(cmd);
  // The file is "there", not here: `test` answers per machine.
  calls.hook = (cmd, args, opts) => cmd === "test" ? { stdout: "", stderr: "", code: opts?.on === "ska" ? 0 : 1 } : null;
  calls.remote = [];
  try {
    const ui = await open();
    await ui.cx.flush();
    expect(ui.view.machine).toBe("ska");
    expect(ui.view.ed.doc.live().some(e => e.text === "There")).toBe(true);
    expect(calls.remote.some(c => c[0] === "ska" && c[4] === "board-read")).toBe(true);
    expect(ui.view.recent[0]).toBe(`ska:${rf}`);
  } finally { Object.assign(calls, was); calls.remote = []; }
});
