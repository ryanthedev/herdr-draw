// The real Herdr adapter, driven headless: built mod + fake GPUI + synthetic mouse/keys.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
    input() { const n = find(ui.tree(), n => n.kind === "input"); return n && { type: t => cxs.call(c => n.state.type(t, c)), submit: () => cxs.call(c => n.state.submit(c)) }; },
    click(id) { ui.fire(id, "on_click", ui.ev(0, 0)); },
    async shot(name) {
      const c = ui.canvas();
      const svg = canvasToSvg(c, { width: view.size.w, height: view.size.h, bg: THEME.background });
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
  ui.key("enter");
  expect(ui.view.ed.doc.live().some(e => e.type === "text" && e.text === "Hi yo")).toBe(true);
  // And when it did take the keyboard after the frame:
  ui.dblclick([170, 460]);
  ui.tree(); await ui.cx.flush(1);
  expect(find(ui.tree(), n => n.kind === "input").state.focused).toBe(true);
});

test("multi-line text: the editor is a textarea; shift-Enter adds a line, Escape finishes", async () => {
  const ui = await open();
  ui.key("t"); ui.on("on_mouse_down:left", ui.ev(300, 520)); ui.on("on_mouse_up:left", ui.ev(300, 520));
  const box = find(ui.tree(), n => n.kind === "input");
  expect(box.multiline).toBe(true);
  // Keyboard not on the box yet: the pane types into it.
  ui.key("a"); ui.key("enter", { shift: true }); ui.key("b");
  expect(ui.view.ed.text.value).toBe("a\nb");
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
