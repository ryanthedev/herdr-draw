// The side panel's layout and the person's own choices for it, free of Herdr so it's tested
// headless: which sections show and in what order, which are folded, stacked or as tabs, how
// wide, and the person's palette and recent colors. One set for every board (prefs.json); the
// adapter draws from it and changes it only through applyPanel(state, op).

import { normalizeColor, pushRecentColor } from "./color.js";

// Every section the panel can show, in the default order. Some show only when they have
// something to say (arrange: a selection; frames: a frame on the board).
export const SECTIONS = [
  { id: "properties", title: "Properties" },
  { id: "arrange", title: "Arrange" },
  { id: "frames", title: "Frames" },
  { id: "animate", title: "Animate" },
  { id: "layers", title: "Layers" },
  { id: "library", title: "Library" },
];
const IDS = SECTIONS.map(s => s.id);
export const titleOf = id => SECTIONS.find(s => s.id === id)?.title ?? id;

export const WIDTH = { min: 180, max: 520, default: 232 };
export const CANVAS_MIN = 200;          // the board keeps at least this much beside the panel
export const PALETTE_MAX = 24;          // colors per row of the person's palette
export const MODES = ["stack", "tabs"];

export function defaultPanel() {
  return { v: 1, open: true, width: WIDTH.default, order: [...IDS], folded: [], hidden: [], mode: "stack", tab: IDS[0], palette: { stroke: [], fill: [] }, recent: [] };
}

const clampWidth = w => Math.round(Math.max(WIDTH.min, Math.min(WIDTH.max, Number.isFinite(+w) ? +w : WIDTH.default)));
const ids = list => [...new Set((Array.isArray(list) ? list : []).filter(id => IDS.includes(id)))];
const colors = list => [...new Set((Array.isArray(list) ? list : []).map(normalizeColor).filter(Boolean))].slice(0, PALETTE_MAX);

// Whatever prefs.json holds, as a whole, valid state: unknown sections dropped, sections this
// version added appended, width clamped, bad colors gone. Anything unreadable reads as the default.
export function parsePanel(text) {
  let raw;
  try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { raw = null; }
  return normalizePanel(raw);
}

export function normalizePanel(raw) {
  const d = defaultPanel();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const order = ids(raw.order);
  for (const id of IDS) if (!order.includes(id)) order.push(id);
  const hidden = ids(raw.hidden).filter(id => id !== "properties");   // the properties section can't be hidden
  const tab = IDS.includes(raw.tab) && !hidden.includes(raw.tab) ? raw.tab : order.find(id => !hidden.includes(id));
  return {
    v: 1,
    open: raw.open !== false,
    width: clampWidth(raw.width),
    order,
    folded: ids(raw.folded),
    hidden,
    mode: MODES.includes(raw.mode) ? raw.mode : d.mode,
    tab,
    palette: { stroke: colors(raw.palette?.stroke), fill: colors(raw.palette?.fill) },
    recent: pushRecentColor(raw.recent, null),
  };
}

export const serializePanel = state => JSON.stringify(normalizePanel(state), null, 2) + "\n";

// The only way the panel state changes. Returns a new state (the old one is left alone); an op
// that changes nothing returns the same object, so callers can skip a save.
export function applyPanel(state, op) {
  const s = normalizePanel(state);
  const same = next => (serializePanel(next) === serializePanel(s) ? state : next);
  switch (op?.type) {
    case "open": return same({ ...s, open: op.open ?? !s.open });
    case "width": return same({ ...s, width: clampWidth(op.width) });
    case "fold": {
      const folded = op.folded ?? !s.folded.includes(op.id);
      if (!IDS.includes(op.id)) return state;
      return same({ ...s, folded: folded ? [...s.folded.filter(x => x !== op.id), op.id] : s.folded.filter(x => x !== op.id) });
    }
    case "foldAll": return same({ ...s, folded: op.folded ? [...IDS] : [] });
    case "move": {   // put section `id` at position `to` in the full order
      if (!IDS.includes(op.id)) return state;
      const rest = s.order.filter(x => x !== op.id), to = Math.max(0, Math.min(rest.length, Math.round(op.to)));
      return same({ ...s, order: [...rest.slice(0, to), op.id, ...rest.slice(to)] });
    }
    case "hide": {
      if (!IDS.includes(op.id) || op.id === "properties") return state;
      const hide = op.hidden ?? !s.hidden.includes(op.id);
      const hidden = hide ? [...s.hidden.filter(x => x !== op.id), op.id] : s.hidden.filter(x => x !== op.id);
      return same(normalizePanel({ ...s, hidden, tab: s.tab === op.id && hide ? null : s.tab }));
    }
    case "moveOnto": return moveOnto(state, op.id, op.target);
    case "mode": return MODES.includes(op.mode) ? same({ ...s, mode: op.mode }) : state;
    case "tab": return IDS.includes(op.id) && !s.hidden.includes(op.id) ? same({ ...s, tab: op.id, mode: "tabs" }) : state;
    case "addColor": {   // to the person's palette (kind: "stroke" | "fill")
      const c = normalizeColor(op.color), kind = op.kind === "fill" ? "fill" : "stroke";
      if (!c || s.palette[kind].includes(c)) return state;
      return same({ ...s, palette: { ...s.palette, [kind]: [...s.palette[kind], c].slice(-PALETTE_MAX) } });
    }
    case "removeColor": {
      const c = normalizeColor(op.color), kind = op.kind === "fill" ? "fill" : "stroke";
      return same({ ...s, palette: { ...s.palette, [kind]: s.palette[kind].filter(x => x !== c) } });
    }
    case "used": return same({ ...s, recent: pushRecentColor(s.recent, op.color) });   // a color was applied
    case "reset": return same({ ...defaultPanel(), palette: s.palette, recent: s.recent });   // layout only; colors stay
    default: return state;
  }
}

// What to draw for a pane `paneW` px wide: whether the panel shows and how wide it is. The board
// keeps CANVAS_MIN; past that the panel narrows to WIDTH.min, then hides.
export function panelLayout(state, paneW) {
  const s = normalizePanel(state);
  const room = (Number(paneW) || 0) - CANVAS_MIN;
  if (!s.open || room < WIDTH.min) return { show: false, width: 0 };
  return { show: true, width: Math.min(s.width, room) };
}

// The sections to draw, in order: { id, title, folded, active }. `available(id)` says whether a
// section has anything to show right now (no selection: no Arrange). In tabs mode every visible
// section gets a tab, and only the active one is drawn (`active`); its tab falls back to the
// first available one.
export function panelSections(state, available = () => true) {
  const s = normalizePanel(state);
  const list = s.order.filter(id => !s.hidden.includes(id) && available(id));
  const tab = list.includes(s.tab) ? s.tab : list[0];
  return list.map(id => ({ id, title: titleOf(id), folded: s.mode === "stack" && s.folded.includes(id), active: s.mode === "tabs" ? id === tab : true }));
}

// Dragging the panel's left edge: the panel sits on the right, so moving left widens it.
export const dragWidth = (startWidth, startX, x) => clampWidth(startWidth + (startX - x));

// Dragging a section title over another one: the dragged section takes the other's place
// (below it when coming from above, above it when coming from below), as list reorders feel.
export function moveOnto(state, id, target) {
  const s = normalizePanel(state), from = s.order.indexOf(id), at = s.order.indexOf(target);
  if (from < 0 || at < 0 || from === at) return state;
  const rest = s.order.filter(x => x !== id), t = rest.indexOf(target);
  return applyPanel(state, { type: "move", id, to: from < at ? t + 1 : t });
}
