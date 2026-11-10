// Drawing cost for big boards (core/render.js): fewer paint calls without changing what shows on
// top, clean lines when zoomed far out, unreadable text and off-screen shapes left out of the pane.
import { test, expect } from "bun:test";
import { planBatches, paintScene, CLEAN_BELOW, TEXT_MIN } from "../core/render.js";
import { exportScene } from "../core/export.js";
import { Editor } from "../core/editor.js";
import { Doc } from "../core/doc.js";

const P = (key, x, y, w = 10) => ({ t: "path", key, cmds: [["M", x, y], ["L", x + w, y], ["L", x + w, y + w]], width: 1 });
const plan = items => planBatches(items, it => it.key);
const pal = { fg: "#fff", bg: "#000", accent: "#0ff", dim: "#888" };

test("paths of one style merge when nothing between overlaps them", () => {
  const p = plan([P("a", 0, 0), P("b", 100, 0), P("a", 200, 0), P("b", 300, 0)]);
  expect(p.layers.map(l => [l.key, l.items.length])).toEqual([["a", 2], ["b", 2]]);
});

test("a path never moves under something drawn after its group that overlaps it", () => {
  // a at 0, then b covering 0..50, then a again inside b: it must stay above b.
  const p = plan([P("a", 0, 0), P("b", 0, 0, 50), P("a", 20, 20)]);
  expect(p.layers.map(l => l.key)).toEqual(["a", "b", "a"]);
  // Paint order of every path, flattened, keeps each overlapping pair in the original order.
  const order = p.layers.flatMap(l => l.items);
  expect(order.indexOf(p.layers[1].items[0])).toBeLessThan(order.indexOf(p.layers[2].items[0]));
});

test("text ends no group and comes back separately; images are their own layer and block merges", () => {
  const img = { t: "image", x: 0, y: 0, w: 40, h: 40 };
  const p = plan([P("a", 0, 0), { t: "text", text: "hi" }, P("a", 200, 0), img, P("a", 10, 10)]);
  expect(p.texts.length).toBe(1);
  expect(p.layers.map(l => l.img ? "img" : `${l.key}${l.items.length}`)).toEqual(["a2", "img", "a1"]);
});

function bigBoard() {
  const ed = new Editor();
  for (let i = 0; i < 40; i++) { ed.tool = "rectangle"; ed.pointerDown({ x: 10 + (i % 8) * 90, y: 10 + Math.floor(i / 8) * 90 }, {}); ed.pointerMove({ x: 70 + (i % 8) * 90, y: 60 + Math.floor(i / 8) * 90 }, {}); ed.pointerUp({ x: 70 + (i % 8) * 90, y: 60 + Math.floor(i / 8) * 90 }, {}); }
  const id = ed.doc.live().find(e => e.type === "rectangle").id;
  ed.select([id]); ed.beginText(ed.doc.get(id), null); ed.setText("Label"); ed.commitText();
  return ed;
}

test(`below ${CLEAN_BELOW}× shapes are drawn clean; text under ${TEXT_MIN} px is left out of the pane, never out of exports`, () => {
  const ed = bigBoard(), doc = ed.doc;
  const at = s => paintScene(doc, { x: 0, y: 0, scale: s }, pal);
  const cmds = s => at(s).filter(i => i.t === "path").reduce((n, i) => n + i.cmds.length, 0);
  expect(cmds(0.2)).toBeLessThan(cmds(0.5) * 0.2 / 0.5 * 2.5 + 1);       // far fewer per shape (clean)
  expect(at(0.1).some(i => i.t === "text")).toBe(false);                  // a 20 px label is 2 px at 10%
  expect(at(1).some(i => i.t === "text")).toBe(true);
  expect(paintScene(doc, { x: 0, y: 0, scale: 0.1 }, pal, { allText: true }).some(i => i.t === "text")).toBe(true);
  expect(exportScene(doc, pal, { scale: 0.1 }).items.some(i => i.t === "text")).toBe(true);
});

test("the pane leaves out shapes that can't reach the screen, and keeps everything while playing", () => {
  const ed = bigBoard();
  ed.select([]); ed.setSize(200, 150); ed.view = { x: 0, y: 0, scale: 1 };
  const rects = new Set(ed.doc.live().filter(e => e.type === "rectangle").map(e => e.id));
  const mine = () => ed.displayList(pal).filter(i => i.t === "path" && rects.has(i.id)).length;
  const shown = mine();
  ed.setSize(2000, 1500);
  const all = mine();
  expect(shown).toBeLessThan(all / 3);
  expect(paintScene(ed.doc, ed.view, pal, { clip: { w: 200, h: 150 }, time: 0 }).filter(i => i.t === "path" && rects.has(i.id)).length).toBe(all);
});
