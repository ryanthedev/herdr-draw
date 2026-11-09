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
  ["Help", [
    ["?", "This list (Esc closes)"],
    ["D in this list", "Play the demo board"],
    ["⌘⇧B", "Anywhere in Herdr: a new board pane"],
  ]],
];
