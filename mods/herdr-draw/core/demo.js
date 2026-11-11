// The demo board: a short animated tour that teaches the keys by showing them. Spell keys out
// (Cmd, Shift): the hand font has no ⌘/⇧ glyphs.
// Built fresh each time (never saved): the pane plays it in its own Editor, beside the person's
// board, so trying things in the demo can't touch their file.

import { makeElement, emptyScene } from "./model.js";
import { mermaidToElements } from "./mermaid.js";
import { bbox, unionBox } from "./geometry.js";
import { isLabel } from "./model.js";

const anim = (preset, start, duration = 600) => ({ preset, start, duration });

function text(str, x, y, fields = {}) {
  return makeElement("text", { x, y, text: str, originalText: str, fontSize: 20, fontFamily: 1, ...fields });
}

export function demoScene() {
  const els = [];
  let t = 0;
  const at = (el, preset, start, dur) => { el.customData = { ...el.customData, anim: anim(preset, start, dur) }; return el; };

  // 1. Title.
  els.push(at(text("herdr-draw: a quick tour", 0, 0, { fontSize: 36 }), "pop", t, 700));
  els.push(at(text("watch it build, then press the keys yourself", 2, 52, { fontSize: 16, strokeColor: "#868e96" }), "fade", t += 500, 600));

  // 2. Shapes, each named by its key, joined by arrows that stay attached.
  const flow = mermaidToElements([
    "flowchart LR",
    "  R[R: rectangle] --> D{D: diamond}",
    "  D -->|A: arrow| O((O: ellipse))",
  ].join("\n"), { origin: { x: 0, y: 120 } });
  const nodes = flow.elements.filter(e => !isLabel(e) && e.type !== "arrow" && e.type !== "line");
  const fills = ["#a5d8ff", "#ffec99", "#b2f2bb"];
  t += 600;
  nodes.forEach((n, i) => { n.backgroundColor = fills[i % fills.length]; at(n, "pop", t + i * 900, 600); });
  for (const e of flow.elements) {
    if (e.type === "arrow" || e.type === "line") {
      const from = nodes.findIndex(n => n.id === e.startBinding?.elementId);
      at(e, "draw", t + from * 900 + 550, 450);
    }
  }
  // Labels animate with their shape or arrow.
  for (const l of flow.elements.filter(isLabel)) {
    const host = flow.elements.find(e => e.id === l.containerId);
    if (host?.customData?.anim) l.customData = { ...l.customData, anim: { ...host.customData.anim } };
  }
  els.push(...flow.elements);
  t += nodes.length * 900 + 200;

  const box = unionBox(flow.elements.filter(e => !isLabel(e)).map(bbox));
  let y = box.y + box.h + 50;

  // 3. A pen stroke, drawn on.
  const pts = []; for (let i = 0; i <= 40; i++) pts.push([i * 6, Math.sin(i / 4) * 14]);
  const pen = makeElement("freedraw", { x: 0, y: y + 14, points: pts, width: 240, height: 28, strokeColor: "#e03131", strokeWidth: 2 });
  els.push(at(pen, "draw", t, 900));
  els.push(at(text("P: pen", 260, y, { strokeColor: "#e03131" }), "fade", t + 300, 500));
  t += 1100; y += 70;

  // 4. The rest, typed out one line at a time.
  const lines = [
    "T or double-click: write text (Cmd+Enter finishes)",
    "V: select · drag a corner to resize · the top dot rotates",
    "C B S W: color, fill, dash, width of the selection",
    "I: side panels · Animate: pick fade, rise, pop, draw…",
    "Shift+Space plays it, like this tour",
  ];
  for (const l of lines) { els.push(at(text(l, 0, y), "draw", t, 900)); t += 1000; y += 38; }

  // 5. Where help lives.
  const help = makeElement("rectangle", { x: 0, y: y + 20, width: 470, height: 56, backgroundColor: "#eebefa", roundness: { type: 3 }, strokeColor: "#9c36b5" });
  const hl = makeElement("text", { x: 0, y: 0, text: "? shows every shortcut · Esc leaves the demo", originalText: "? shows every shortcut · Esc leaves the demo", fontSize: 18, fontFamily: 2, containerId: help.id, textAlign: "center", verticalAlign: "middle" });
  help.boundElements = [{ id: hl.id, type: "text" }];
  at(help, "pop", t, 600); hl.customData = { ...hl.customData, anim: anim("pop", t, 600) };
  els.push(help, hl);
  t += 700;

  // z order: as listed.
  els.forEach((e, i) => { e.customData = { ...e.customData, z: i + 1 }; });
  const scene = emptyScene();
  scene.elements = els;
  scene.appState.herdr.timeline = { duration: t + 900 };
  return scene;
}
