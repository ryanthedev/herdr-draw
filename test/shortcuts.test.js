// The help list (core/shortcuts.js) against the real key handler: every probe must be taken by
// Editor.key and change something, so ? never shows a key that does nothing.
import { test, expect } from "bun:test";
import { setup } from "./harness/fixture.js";
import { SHORTCUTS } from "../core/shortcuts.js";
import { TOOLS } from "../core/editor.js";
import { demoScene } from "../core/demo.js";
import { Editor } from "../core/editor.js";
import { isLabel } from "../core/model.js";

const state = ed => JSON.stringify({
  els: ed.doc.live().map(e => [e.id, e.version, e.isDeleted]), tool: ed.tool, sel: [...ed.sel], view: ed.view,
  lock: ed.toolLock, style: ed.style, play: !!ed.play, grid: ed.grid, text: !!ed.text,
});

function prepared(kind) {
  const t = setup();
  const boxes = { sel: 1, redo: 1, sel2: 2, two: 2, sel3: 3 }[kind] ?? 0;
  for (let i = 0; i < boxes; i++) { t.key("r"); t.drag([100 + i * 150 + i * i * 30, 100 + i * 37], [180 + i * 150 + i * i * 30, 160 + i * 37]); }
  if (kind === "sel2" || kind === "sel3") t.ed.select(t.byType("rectangle").map(e => e.id));
  if (kind === "redo") t.key("z", { cmd: true });
  if (kind === "hand") t.key("h");
  if (boxes) t.key("v");
  return t;
}

const rows = SHORTCUTS.flatMap(([group, rs]) => rs.map(r => [group, ...r]));

test.each(rows.filter(r => r[3]).map(([g, keys, what, probe]) => [`${g}: ${keys} (${what})`, probe]))("%s", (_name, [key, mods, kind]) => {
  const t = prepared(kind);
  const before = state(t.ed);
  expect(t.ed.key(key, mods)).toBe(true);
  expect(state(t.ed)).not.toBe(before);
});

test("the help lists every tool by its keys", () => {
  for (const tool of TOOLS) expect(rows.some(r => r[3]?.[0] === tool.keys[0] && r[1].includes(tool.keys[0].toUpperCase()))).toBe(true);
});

test("the demo is a board that plays: animated shapes, bound arrows, labels with their shape", () => {
  const scene = demoScene(), els = scene.elements;
  const ed = new Editor({ scene });
  expect(ed.duration()).toBeGreaterThan(5000);
  expect(els.filter(e => e.customData?.anim).length).toBe(els.length);   // everything enters on the timeline
  const arrows = els.filter(e => e.type === "arrow");
  expect(arrows.length).toBe(2);
  for (const a of arrows) expect(els.some(e => e.id === a.endBinding?.elementId)).toBe(true);
  for (const l of els.filter(isLabel)) expect(l.customData.anim).toEqual(els.find(e => e.id === l.containerId).customData.anim);
  // At t = 0 the title is entering and the closing help box hasn't appeared yet.
  const last = els[els.length - 2];
  expect(last.customData.anim.start).toBeGreaterThan(ed.duration() - 2000);
});

import { takenKeys, fitKeys } from "../core/shortcuts.js";

test("a ⌘ key the person's Herdr uses shows as ⌃, which the board takes too", () => {
  const taken = takenKeys(JSON.stringify({ global: { "cmd-a": "agent.next", "cmd-d": "pane.split:right", "cmd-]": "agent.next", "cmd-shift-l": "x", "ctrl-1": "space.select:1" },
    "layout:matrix": { "cmd-g": "x" }, terminal: { "cmd-c": "terminal.copy" }, "mod:herdr-draw": { "cmd-d": "herdr-draw.duplicate" } }));
  expect(fitKeys("⌘A", taken)).toBe("⌃A");
  expect(fitKeys("⌘D", taken)).toBe("⌘D");                      // mod:herdr-draw gave it back
  expect(fitKeys("⌘]  ⌘[", taken)).toBe("⌃]  ⌘[");
  expect(fitKeys("⌘G  ⌘⇧G", taken)).toBe("⌃G  ⌘⇧G");          // any layout's keys count
  expect(fitKeys("⌘⇧L", taken)).toBe("⌃⇧L");
  expect(fitKeys("⌘C  ⌘X  ⌘V", taken)).toBe("⌘C  ⌘X  ⌘V");    // terminal-only keys don't reach a board
  expect(fitKeys("Lock (⌘⇧L)", taken)).toBe("Lock (⌃⇧L)");
  expect(takenKeys("not json").size).toBe(0);
});

test("every ⌘ shortcut the board lists also works with ⌃", () => {
  for (const [, rows] of SHORTCUTS) for (const [keys, , probe] of rows) {
    if (!probe || !probe[1].cmd) continue;
    const t = prepared(probe[2]), before = state(t.ed);
    expect(t.ed.key(probe[0], { ...probe[1], cmd: false, ctrl: true })).toBe(true);
    expect(state(t.ed)).not.toBe(before);
  }
});
