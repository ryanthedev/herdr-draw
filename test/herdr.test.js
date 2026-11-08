// The real Herdr adapter, driven headless: built mod + fake GPUI + synthetic mouse/keys.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
const realImages = () => { calls.real = (cmd, args) => ["mkdir", "test", "rm", "stat", "cat"].includes(cmd) || (cmd === "sh" && ["img-import", "img-cache", "big-write", "png-export"].includes(args[2])); };

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
  expect(textOf(ui.tree())).toContain("only images");
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
