// Every shortcut, in one list: the help overlay (?) shows it, and test/shortcuts.test.js presses
// each `probe` on a real Editor so the list can't drift from the key handler (Editor.key).
//
// Row: [keys shown, what it does, probe?]   probe = [key, mods, setup?] as Editor.key takes them;
// setup "sel" draws and selects a box first, "sel2"/"sel3" two/three boxes, "two" draws
// two and leaves the last one selected, "hand" starts on the Hand tool, "redo" draws one and undoes it. Rows without a probe are mouse gestures or
// handled by an adapter (copy/paste, export, help), and are checked there.

import { TOOLS } from "./editor.js";

const toolRows = TOOLS.map(t => [t.keys.map(k => k.toUpperCase()).join(" or "), `${t.icon}  ${t.name}`, [t.keys[0], {}, t.id === "select" ? "hand" : undefined]]);

export const SHORTCUTS = [
  ["Draw", [
    ...toolRows,
    ["Q", "Keep the tool after drawing (lock)", ["q", {}]],
    ["Esc", "Back to Select, clear the selection", ["escape", {}, "sel"]],
    ["double-click", "Write text there (on a shape: its label)"],
    ["Enter", "Edit the selected shape's label", ["enter", {}, "sel"]],
    ["⌘Enter or Esc", "Finish writing (Enter alone = new line)"],
  ]],
  ["Edit", [
    ["⌘Z", "Undo", ["z", { cmd: true }, "sel"]],
    ["⌘⇧Z or ⌘Y", "Redo", ["y", { cmd: true }, "redo"]],
    ["⌘C  ⌘X  ⌘V", "Copy, cut, paste (also images, Mermaid text)"],
    ["⌘D", "Duplicate", ["d", { cmd: true }, "sel"]],
    ["⌘A", "Select all", ["a", { cmd: true }, "two"]],
    ["Delete", "Delete the selection", ["backspace", {}, "sel"]],
    ["arrows", "Nudge (⇧ = 20 px)", ["left", {}, "sel"]],
    ["⌘G  ⌘⇧G", "Group, ungroup", ["g", { cmd: true }, "sel2"]],
    ["⌘⇧L", "Lock / unlock", ["l", { cmd: true, shift: true }, "sel"]],
  ]],
  ["Arrows", [
    ["● dot", "Arrow tool over a shape: end on a dot to stay on that side"],
    ["⌘ drag", "Draw without attaching to shapes"],
    ["drag ○", "On a selected arrow: bend it there"],
    ["double-click", "On a bend: remove it"],
    ["side panel", "Sharp, curve or elbow; + bend, straighten"],
  ]],
  ["Style (selection, or the next shape)", [
    ["C", "Next stroke color", ["c", {}]],
    ["B", "Next fill color", ["b", {}]],
    ["S", "Solid, dashed, dotted", ["s", {}]],
    ["W", "Stroke width", ["w", {}]],
    ["G", "Sketchy or clean", ["g", {}]],
    ["=  -", "Bigger, smaller text", ["=", {}]],
  ]],
  ["Arrange", [
    ["⌥A ⌥D ⌥W ⌥S", "Align left, right, top, bottom", ["a", { alt: true }, "sel2"]],
    ["⌥H ⌥V", "Align centers", ["h", { alt: true }, "sel2"]],
    ["⇧H  ⇧V", "Distribute across, down", ["h", { shift: true }, "sel3"]],
    ["]  [", "Forward, backward", ["]", {}, "sel"]],
    ["⌘]  ⌘[", "To front, to back", ["]", { cmd: true }, "sel"]],
    ["<  >", "Rotate 15° (drag the top handle: free; ⇧ snaps)", [">", {}, "sel"]],
  ]],
  ["View", [
    ["⇧1", "Fit everything", ["1", { shift: true }, "sel"]],
    ["⇧2", "Fit the selection", ["2", { shift: true }, "sel"]],
    ["⌘=  ⌘-  ⌘0", "Zoom in, out, 100%", ["=", { cmd: true }]],
    ["scroll", "Pan; with ⌘: zoom (H or middle-drag pan too)"],
    ["⌘'", "Snap to grid", ["'", { cmd: true }]],
    ["I", "Side panels (style, arrange, animate, layers, library)"],
  ]],
  ["Animate and share", [
    ["⇧Space", "Play / pause the animation", ["space", { shift: true }]],
    ["side panel", "Select, then Animate: fade, rise, pop, draw…"],
    ["⌘⇧E", "Export the board as SVG + PNG"],
    ["drop", "Images and .excalidrawlib libraries"],
  ]],
  ["Frames as pages", [
    ["F", "Draw a frame: one page of the board", ["f", {}]],
    ["PgDn  PgUp", "Next, previous frame, filling the view", ["pagedown", {}, "frames"]],
    ["side panel", "Frames: click one to go there"],
  ]],
  ["Boards", [
    ["⌘O", "Switch this pane to another board, or make one"],
    ["board name", "Click it in the toolbar: the same"],
    ["⌘Enter", "In the list: a new board with the name typed (in ~/boards)"],
  ]],
  ["Help", [
    ["?", "This list (Esc closes)"],
    ["D in this list", "Play the demo board"],
    ["⌘⇧B", "Anywhere in Herdr: a new pane, pick or make a board"],
  ]],
];

// ── keys the person's Herdr already uses ──
// Herdr's keys.json wins over a pane's own keys (a more specific section wins; `mod:herdr-draw` beats
// `global`). The board takes ⌃ wherever it takes ⌘, so a ⌘ shortcut whose key Herdr has is shown as ⌃.

// The keys Herdr will take before a board sees them: global and layout sections, minus mod:herdr-draw.
export function takenKeys(keysJson) {
  let k; try { k = typeof keysJson === "string" ? JSON.parse(keysJson) : keysJson; } catch { return new Set(); }
  if (!k || typeof k !== "object") return new Set();
  const out = new Set();
  for (const [sec, map] of Object.entries(k)) if ((sec === "global" || sec.startsWith("layout:")) && map && typeof map === "object") for (const key of Object.keys(map)) out.add(key.toLowerCase());
  for (const key of Object.keys(k["mod:herdr-draw"] ?? {})) out.delete(key.toLowerCase());
  return out;
}

const KEY_NAME = { "Enter": "enter", "Space": "space", "Delete": "backspace" };
// "⌘A", "⌘⇧L", "⌘]  ⌘[", "⌘=  ⌘-  ⌘0" → the same with ⌃ for each ⌘ key in `taken` (and its ⌃ key free).
export function fitKeys(label, taken) {
  if (!taken?.size) return label;
  return String(label).replace(/⌘(⇧?)(Enter|Space|Delete|[A-Za-z0-9[\]=\-+'/.,;])/g, (all, shift, key) => {
    const name = KEY_NAME[key] ?? key.toLowerCase(), mods = shift ? "shift-" : "";
    return taken.has(`cmd-${mods}${name}`) && !taken.has(`ctrl-${mods}${name}`) ? `⌃${shift}${key}` : all;
  });
}
