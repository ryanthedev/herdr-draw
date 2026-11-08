// The editor: tools, selection, gestures, history, layers, commands.
//
// Platform-free. An adapter feeds it pointer/key events in screen pixels
// (logical, zoom-1) and paints editor.displayList(theme). Every change leaves
// as an op through `onOp` (to the file store today; to a server later), and
// remote/agent ops come in through editor.receive(op).

import {
  DEFAULT_STROKE, BASE_LAYER, makeElement, clone, touch, isShape, isLinear, isLabel, layerOf, zOf, defaultLayer, newId, textSize,
} from "./model.js";
import { Doc } from "./doc.js";
import {
  bbox, unionBox, inBox, boxInBox, center, normalize, hits, hitTest, shapeAt, resolvedPoints, settle, mapIntoBox, distToSeg, segmentsIntersect,
  bounds, corners, rotate, rotateAbout, angleOf, centerOf, toLocal, toWorld as elToWorld, normAngle,
} from "./geometry.js";
import { paintScene, paintElement, project, rectCmds, withAlpha } from "./render.js";
import { PRESETS, timelineEnd } from "./anim.js";
import { labelHostHeight } from "./text.js";
import { isMermaid, mermaidToElements } from "./mermaid.js";

export const TOOLS = [
  { id: "select", keys: ["v", "1"], icon: "↖", name: "Select" },
  { id: "hand", keys: ["h"], icon: "✋", name: "Hand" },
  { id: "rectangle", keys: ["r", "2"], icon: "▭", name: "Rectangle" },
  { id: "diamond", keys: ["d", "3"], icon: "◇", name: "Diamond" },
  { id: "ellipse", keys: ["o", "4"], icon: "◯", name: "Ellipse" },
  { id: "arrow", keys: ["a", "5"], icon: "→", name: "Arrow" },
  { id: "line", keys: ["l", "6"], icon: "╱", name: "Line" },
  { id: "freedraw", keys: ["p", "7"], icon: "✎", name: "Pen" },
  { id: "text", keys: ["t", "8"], icon: "T", name: "Text" },
  { id: "eraser", keys: ["e", "0"], icon: "⌫", name: "Eraser" },
  { id: "frame", keys: ["f"], icon: "#", name: "Frame" },
  { id: "laser", keys: ["k"], icon: "✦", name: "Laser" },
];

export const STROKES = [DEFAULT_STROKE, "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599"];
export const FILLS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#eebefa", "#99e9f2"];
export const WIDTHS = [1, 2, 4];
export const STYLES = ["solid", "dashed", "dotted"];

const HANDLE = 5;          // how close a press must be to a handle, screen px
const SNAP = 6;            // object snap distance, screen px
const DRAG_SLOP = 3;       // px before a press becomes a drag
const ROT_GAP = 24;        // the rotate handle sits this far above the selection, screen px
const ROT_SNAP = Math.PI / 12;   // shift snaps rotation to 15°

export class Editor {
  constructor({ scene, onOp = () => {}, clock = () => Date.now() } = {}) {
    this.doc = new Doc(scene ?? { elements: [] });
    this.onOp = onOp; this.clock = clock;
    this.tool = "select"; this.toolLock = false;
    this.sel = new Set();
    this.view = { x: 40, y: 40, scale: 1 }; this.size = { w: 800, h: 600 };
    this.style = { strokeColor: DEFAULT_STROKE, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, fontSize: 20, fontFamily: 2, roundness: null, elbowed: false };
    this.activeLayer = this.doc.layers[this.doc.layers.length - 1].id;
    this.undoStack = []; this.redoStack = [];
    this.g = null;               // the gesture in progress
    this.hover = null; this.guides = []; this.laser = []; this.erasing = new Set();
    this.text = null;            // { id, value, isNew } while typing
    this.clipboard = null;
    this.peers = new Map();      // presence: id → { name, color, cursor, sel } (networking comes later)
    this.play = null;            // { t0, from } while the timeline plays
    this.scrub = null;           // a paused timeline time, or null for the editing view
    this.flash = null;
    this.version = 0;            // bumps on any visible change; adapters may diff on it
  }

  // ── ports ──────────────────────────────────────────────────────────────

  load(scene) { this.doc.load(scene); this.pruneSel(); this.fixLayer(); this.changed(); }
  receive(op) { const ch = this.doc.apply(op); if (ch.length) { this.pruneSel(); this.fixLayer(); this.changed(); } return ch; }
  scene() { return this.doc.toScene(); }
  changed() { this.version++; }
  setSize(w, h) { this.size = { w, h }; }

  pruneSel() { for (const id of this.sel) if (!this.doc.get(id)) this.sel.delete(id); }
  fixLayer() { if (!this.doc.layers.some(l => l.id === this.activeLayer)) this.activeLayer = this.doc.layers[this.doc.layers.length - 1].id; }

  toWorld(p) { return { x: p.x / this.view.scale - this.view.x, y: p.y / this.view.scale - this.view.y }; }
  toScreen(p) { return { x: (p.x + this.view.x) * this.view.scale, y: (p.y + this.view.y) * this.view.scale }; }

  // ── changing the board ─────────────────────────────────────────────────

  // Run fn(tx) and commit its edits as one undoable step.
  transact(fn, { history = true, files } = {}) {
    const tx = new Tx(this.doc);
    const result = fn(tx);
    this.commit(tx.before, tx.dirty, history, files);
    return result;
  }

  // `files`: image blobs that ride along in the same op (so no replica sees the element without its file).
  commit(before, dirty, history = true, files) {
    if (!dirty.size) return;
    const elements = [];
    for (const [id, el] of dirty) {
      // Arrows bound to anything that moved get their baked geometry refreshed.
      elements.push(touch(el));
    }
    this.doc.apply({ elements }, { force: true });
    const settled = this.settleArrows(new Set(dirty.keys()), before);
    if (settled.length) elements.push(...settled);
    if (files) { this.doc.apply({ files }); this.onOp({ elements, files }); }
    else this.onOp({ elements });
    if (history) { this.undoStack.push(before); this.redoStack = []; if (this.undoStack.length > 200) this.undoStack.shift(); }
    this.changed();
  }

  settleArrows(ids, before) {
    const out = [];
    for (const el of this.doc.live()) {
      if (el.type !== "arrow" && el.type !== "line") continue;
      const s = el.startBinding?.elementId, e = el.endBinding?.elementId;
      if (!ids.has(el.id) && !ids.has(s) && !ids.has(e)) continue;
      const c = clone(el);
      if (settle(this.doc, c)) { if (!before.has(el.id)) before.set(el.id, clone(el)); touch(c); this.doc.apply({ elements: [c] }, { force: true }); out.push(c); }
    }
    return out;
  }

  // Undo applies the saved "before" copies as new versions, so it travels like any edit.
  undo() { this.swapHistory(this.undoStack, this.redoStack); }
  redo() { this.swapHistory(this.redoStack, this.undoStack); }
  swapHistory(from, to) {
    const before = from.pop(); if (!before) return;
    const back = new Map(), elements = [];
    for (const [id, old] of before) {
      const cur = this.doc.getAny(id);
      back.set(id, cur ? clone(cur) : null);
      const next = old ? clone(old) : { ...clone(cur), isDeleted: true };
      next.version = Math.max(cur?.version ?? 0, old?.version ?? 0); touch(next);
      elements.push(next);
    }
    to.push(back);
    this.doc.apply({ elements }, { force: true });
    this.onOp({ elements });
    this.pruneSel(); this.changed();
  }

  setAppState(patch, history = false) {
    this.doc.apply({ appState: patch });
    this.onOp({ appState: patch });
    this.changed();
  }

  newEl(type, fields) {
    return makeElement(type, { ...fields, customData: { layer: this.activeLayer, z: this.doc.maxZ(this.activeLayer) + 1, ...(fields.customData ?? {}) } });
  }

  // ── selection ──────────────────────────────────────────────────────────

  selected() { return [...this.sel].map(id => this.doc.get(id)).filter(Boolean); }
  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this.changed();
  }
  // Clicking one member of a group picks the whole (outermost) group.
  withGroup(el) {
    const g = el.groupIds?.[el.groupIds.length - 1];
    return g ? this.doc.live().filter(e => e.groupIds?.includes(g)).map(e => e.id) : [el.id];
  }
  selBox() { const els = this.selected().filter(e => !isLabel(e)); return els.length ? unionBox(els.map(bounds)) : null; }

  // One rotated shape is resized and outlined in its own frame; anything else uses the axis-aligned box.
  soloRotated() { const els = this.selected().filter(e => !isLabel(e)); return els.length === 1 && angleOf(els[0]) ? els[0] : null; }

  // The selection frame as 4 screen corners (nw, ne, se, sw), padded.
  selFrame(padPx = 8) {
    const s = this.view.scale, pad = padPx / s, el = this.soloRotated();
    if (el) {
      const b = bbox(el);
      return [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]]
        .map(([x, y]) => this.toScreen(elToWorld(el, { x, y })));
    }
    const b = this.selBox(); if (!b) return null;
    return [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen({ x, y }));
  }
  selCenter() { const el = this.soloRotated(); if (el) return centerOf(el); const b = this.selBox(); return b && center(b); }

  // Screen-space handles of the selection: 8 resize handles, or a linear element's points.
  handles() {
    const els = this.selected().filter(e => this.doc.editable(e));
    if (els.length === 1 && isLinear(els[0]) && els[0].type !== "freedraw") {
      const pts = resolvedPoints(this.doc, els[0]);
      // An elbow's bends are routed, not placed: only its two ends have handles.
      if (els[0].elbowed) return [[0, pts[0]], [els[0].points.length - 1, pts[pts.length - 1]]].map(([i, p]) => ({ kind: "point", i, ...this.toScreen({ x: p[0], y: p[1] }) }));
      return pts.map((p, i) => ({ kind: "point", i, ...this.toScreen({ x: p[0], y: p[1] }) }));
    }
    const f = this.selFrame(); if (!f || !els.length) return [];
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const [nw, ne, se, sw] = f, n = mid(nw, ne);
    // The rotate handle: out from the top edge's middle, away from the center.
    const c = mid(nw, se), len = Math.hypot(n.x - c.x, n.y - c.y) || 1;
    const rot = { kind: "rotate", x: n.x + (n.x - c.x) / len * ROT_GAP, y: n.y + (n.y - c.y) / len * ROT_GAP };
    if (els.length === 1 && els[0].type === "text") return [rot];
    return [["nw", nw], ["n", n], ["ne", ne], ["e", mid(ne, se)], ["se", se], ["s", mid(se, sw)], ["sw", sw], ["w", mid(sw, nw)]]
      .map(([dir, p]) => ({ kind: "resize", dir, x: p.x, y: p.y })).concat([rot]);
  }
  handleAt(p) { return this.handles().find(h => Math.abs(h.x - p.x) <= HANDLE && Math.abs(h.y - p.y) <= HANDLE) ?? null; }

  // ── pointer input (screen px) ──────────────────────────────────────────

  pointerDown(p, m = {}) {
    if (this.text) this.commitText();
    // A press that arrives mid-gesture means we missed a release (outside the pane): finish it first.
    if (this.g && this.g.kind !== "poly") this.pointerUp(this.g.last ?? p, {});
    const w = this.toWorld(p);
    this.downAt = { p, t: this.clock() };

    if (this.g?.kind === "poly") {   // adding points to a click-by-click line
      if (m.clickCount >= 2) return this.finishPoly();
      const el = this.g.el; el.points[el.points.length - 1] = [w.x - el.x, w.y - el.y]; el.points.push([w.x - el.x, w.y - el.y]);
      return this.livePut(el);
    }
    if (m.button === "middle" || this.tool === "hand" || m.space) { this.g = { kind: "pan", start: p, view: { ...this.view } }; return; }

    if (m.clickCount >= 2 && (this.tool === "select" || this.tool === "text")) {
      const hit = hitTest(this.doc, w, this.tol()) ?? shapeAt(this.doc, w);
      if (hit && (isShape(hit) || hit.type === "text" || isLinear(hit)) && this.doc.editable(hit)) return this.beginText(hit, w);
      if (!hit) return this.beginText(null, w);
    }

    switch (this.tool) {
      case "select": return this.downSelect(p, w, m);
      case "text": return this.beginText(null, w);
      case "laser": this.laser.push({ x: w.x, y: w.y, t: this.clock(), start: true }); this.g = { kind: "laser" }; return this.changed();
      case "eraser": this.g = { kind: "erase", last: p }; this.eraseAt(w, w); return;
      default: return this.downCreate(p, w, m);
    }
  }

  tol() { return 6 / this.view.scale; }

  downSelect(p, w, m) {
    const h = this.handleAt(p);
    if (h) {
      const els = [...this.selected()];
      for (const e of this.selected()) { const l = isShape(e) && this.doc.labelOf(e); if (l && !els.includes(l)) els.push(l); }
      const orig = new Map(els.map(e => [e.id, clone(e)])), before = new Map(els.map(e => [e.id, clone(e)]));
      if (h.kind === "rotate") {
        const c = this.selCenter();
        this.g = { kind: "rotate", c, a0: Math.atan2(w.y - c.y, w.x - c.x), solo: this.soloRotated() ?? (els.filter(e => !isLabel(e)).length === 1 ? els[0] : null), orig, before };
        return;
      }
      this.g = { kind: h.kind === "point" ? "point" : "resize", h, start: w, box: this.selBox(), solo: this.soloRotated(), orig, before };
      return;
    }
    let hit = hitTest(this.doc, w, this.tol());
    // Inside the current selection's box, a press grabs the selection, even in the
    // empty middle of an unfilled shape, unless it lands on some other element.
    if ((!hit || this.sel.has(hit.id)) && !m.shift && this.sel.size) {
      const b = this.selBox();
      if (b && inBox(w, b, this.tol())) hit = this.selected().find(e => !isLabel(e) && this.doc.editable(e)) ?? hit;
    }
    if (hit) {
      const ids = this.withGroup(hit);
      if (m.shift) { if (this.sel.has(hit.id)) ids.forEach(id => this.sel.delete(id)); else ids.forEach(id => this.sel.add(id)); this.changed(); }
      else if (!this.sel.has(hit.id)) this.select(ids);
      if (!this.doc.editable(hit)) return;
      this.g = { kind: "move", start: w, p, alt: !!m.alt, moved: false };
      return;
    }
    if (!m.shift) this.select([]);
    this.g = { kind: "marquee", start: w, end: w, base: new Set(this.sel) };
  }

  downCreate(p, w, m) {
    const at = this.snapPoint(w);
    const s = this.style;
    const fields = { x: at.x, y: at.y, strokeColor: s.strokeColor, backgroundColor: isShape({ type: this.tool }) ? s.backgroundColor : "transparent", fillStyle: s.fillStyle, strokeWidth: s.strokeWidth, strokeStyle: s.strokeStyle, roughness: s.roughness, opacity: s.opacity, roundness: this.tool === "rectangle" || this.tool === "diamond" || this.tool === "line" || this.tool === "arrow" ? s.roundness : null };
    if (this.tool === "arrow" || this.tool === "line") {
      fields.points = [[0, 0], [0, 0]];
      if (this.tool === "arrow" && s.elbowed) { fields.elbowed = true; fields.roundness = null; }
      const target = shapeAt(this.doc, w);
      if (target) fields.startBinding = { elementId: target.id, focus: 0, gap: 6 };
    }
    if (this.tool === "frame") Object.assign(fields, { backgroundColor: "transparent", strokeWidth: 1, name: `Frame ${this.doc.live().filter(e => e.type === "frame").length + 1}`, customData: { z: this.doc.minZ(this.activeLayer) - 1 } });
    const el = this.newEl(this.tool, fields);
    this.g = { kind: "create", start: at, el, p, before: new Map([[el.id, null]]) };
    this.livePut(el);
  }

  pointerMove(p, m = {}) {
    const g = this.g;
    if (!g) { this.updateHover(p); return; }
    g.last = p;
    const w = this.toWorld(p);
    switch (g.kind) {
      case "pan": this.view = { ...g.view, x: g.view.x + (p.x - g.start.x) / this.view.scale, y: g.view.y + (p.y - g.start.y) / this.view.scale }; return this.changed();
      case "marquee": {
        g.end = w;
        const box = normBox(g.start, w);
        this.sel = new Set(g.base);
        for (const el of this.doc.visible()) if (!isLabel(el) && boxInBox(bounds(el), box)) this.withGroup(el).forEach(id => this.sel.add(id));
        return this.changed();
      }
      case "move": return this.moveSel(g, p, w, m);
      case "resize": return g.solo ? this.resizeRotated(g, w, m) : this.resizeSel(g, w, m);
      case "rotate": return this.rotateSel(g, w, m);
      case "point": return this.movePoint(g, w);
      case "create": return this.dragCreate(g, w, m);
      case "poly": { const el = g.el; el.points[el.points.length - 1] = [w.x - el.x, w.y - el.y]; return this.livePut(el); }
      case "erase": { const from = this.toWorld(g.lastE ?? p); g.lastE = p; this.eraseAt(from, w); return; }
      case "laser": this.laser.push({ x: w.x, y: w.y, t: this.clock() }); return this.changed();
    }
  }

  pointerUp(p, m = {}) {
    const g = this.g; if (!g || g.kind === "poly") return;   // a click-by-click line keeps going
    this.g = null; this.guides = [];
    switch (g.kind) {
      case "move": {
        if (!g.moved) return this.changed();
        const dirty = new Map(this.selected().map(e => [e.id, clone(e)]));
        for (const id of g.extra ?? []) { const e = this.doc.get(id); if (e) dirty.set(id, clone(e)); }
        return this.commitGesture(g.before, dirty);
      }
      case "resize": case "point": case "rotate": {
        const dirty = new Map([...g.orig.keys()].map(id => [id, clone(this.doc.get(id))]).filter(([, e]) => e));
        if (g.kind === "point") this.rebind(dirty.values().next().value, g.h.i);
        return this.commitGesture(g.before, dirty);
      }
      case "create": return this.finishCreate(g, p);
      case "erase": return this.finishErase();
      case "laser": return;
      default: return this.changed();
    }
  }

  wheel(delta, p, m = {}) {
    if (m.ctrl || m.cmd) {
      const f = Math.exp(-delta.y * 0.01);
      return this.zoomAt(this.view.scale * f, p);
    }
    this.view = { ...this.view, x: this.view.x - delta.x / this.view.scale, y: this.view.y - delta.y / this.view.scale };
    this.changed();
  }

  zoomAt(next, p = { x: this.size.w / 2, y: this.size.h / 2 }) {
    next = Math.max(0.1, Math.min(8, next));
    const w = this.toWorld(p);
    this.view = { scale: next, x: p.x / next - w.x, y: p.y / next - w.y };
    this.changed();
  }

  updateHover(p) {
    if (this.tool !== "select") { if (this.hover) { this.hover = null; this.changed(); } return; }
    const hit = hitTest(this.doc, this.toWorld(p), this.tol());
    const id = hit?.id ?? null;
    if (id !== this.hover) { this.hover = id; this.changed(); }
  }

  // Put a working copy into the board without history (live drag), and tell the store.
  livePut(...els) {
    const out = els.map(e => { const c = clone(e); c.version = (this.doc.getAny(e.id)?.version ?? 0) + 1; return c; });
    this.doc.apply({ elements: out }, { force: true });
    this.onOp({ elements: out, transient: true });
    this.changed();
  }

  commitGesture(before, dirty) {
    for (const [id, el] of dirty) { if (isLinear(el) || isShape(el)) normalize(el); }
    // dirty copies are fresh; bump them past the live versions
    for (const el of dirty.values()) el.version = this.doc.getAny(el.id)?.version ?? el.version;
    this.commit(before, dirty);
  }

  moveSel(g, p, w, m) {
    if (!g.moved && Math.hypot(p.x - g.p.x, p.y - g.p.y) < DRAG_SLOP) return;
    if (!g.moved) {
      g.moved = true;
      // Alt-drag leaves copies behind (the originals move).
      if (g.alt) this.duplicateInPlace();
      const ids = new Set(this.sel);
      for (const id of [...ids]) { const el = this.doc.get(id); const l = el && isShape(el) && this.doc.labelOf(el); if (l) ids.add(l.id); }
      g.extra = [...ids].filter(id => !this.sel.has(id));
      g.orig = new Map([...ids].map(id => [id, clone(this.doc.get(id))]).filter(([, e]) => e && this.doc.editable(e)));
      g.before = new Map([...g.orig].map(([id, e]) => [id, clone(e)]));
      g.box = unionBox([...g.orig.values()].filter(e => !isLabel(e)).map(bounds));
    }
    let dx = w.x - g.start.x, dy = w.y - g.start.y;
    if (m.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    ({ dx, dy } = this.snapMove(g.box, dx, dy, new Set(g.orig.keys())));
    const els = [];
    for (const [, o] of g.orig) { const c = clone(o); c.x = o.x + dx; c.y = o.y + dy; els.push(c); }
    this.livePut(...els);
  }

  resizeSel(g, w, m) {
    const b = g.box, d = g.h.dir;
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    // Move the grabbed edges by how far the pointer moved, not to the pointer.
    const at = this.snapPoint({ x: w.x - g.start.x, y: w.y - g.start.y });
    if (d.includes("w")) x0 += at.x; if (d.includes("e")) x1 += at.x;
    if (d.includes("n")) y0 += at.y; if (d.includes("s")) y1 += at.y;
    if (this.keepAspect(m) && b.w && b.h) {   // keep proportions
      const r = b.w / b.h, nw = x1 - x0, nh = y1 - y0;
      if (d === "e" || d === "w") y1 = y0 + Math.abs(nw) / r;
      if (d === "n" || d === "s") x1 = x0 + Math.abs(nh) * r;
      if (d.length === 2) { if (Math.abs(nw / r) > Math.abs(nh)) { const h = nw / r * Math.sign(nh || 1) * Math.sign(nw || 1); if (d.includes("n")) y0 = y1 - Math.abs(h) * Math.sign(nh || 1); else y1 = y0 + Math.abs(h) * Math.sign(nh || 1); } else { const ww = Math.abs(nh * r) * Math.sign(nw || 1); if (d.includes("w")) x0 = x1 - ww; else x1 = x0 + ww; } }
    }
    const to = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    const els = [];
    for (const [, o] of g.orig) {
      const c = clone(o); mapIntoBox(c, o, b, to);
      // A shape never gets shorter than its wrapped label (it grows as it narrows).
      const l = isShape(c) && this.doc.labelOf(c); if (l) this.fitHost(c, l);
      els.push(c);
    }
    this.livePut(...els);
  }

  // Turn the selection about its center; shift snaps the angle to 15°.
  rotateSel(g, w, m) {
    let da = Math.atan2(w.y - g.c.y, w.x - g.c.x) - g.a0;
    if (m.shift) {
      const base = g.solo && !isLinear(g.solo) ? g.solo.angle || 0 : 0;
      da = Math.round((base + da) / ROT_SNAP) * ROT_SNAP - base;
    }
    const els = [];
    for (const [, o] of g.orig) {
      const c = clone(o);
      if (isLabel(o)) { const host = g.orig.get(o.containerId); c.angle = host ? normAngle((host.angle || 0) + da) : o.angle; }
      else rotateAbout(c, o, g.c, da);
      els.push(c);
    }
    this.livePut(...els);
  }

  // Shift keeps proportions; for images (photos, screenshots) it's the other way round, as in Excalidraw.
  keepAspect(m) {
    const els = this.selected().filter(e => !isLabel(e));
    const images = els.length > 0 && els.every(e => e.type === "image");
    return !!m.shift !== images;
  }

  // Resize one rotated shape in its own frame, keeping the opposite handle fixed on screen.
  resizeRotated(g, w, m) {
    const o = g.solo, orig = g.orig.get(o.id), b = bbox(orig), a = angleOf(orig), d = g.h.dir;
    const p = toLocal(orig, w), s = toLocal(orig, g.start);
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    const dx = p.x - s.x, dy = p.y - s.y;
    if (d.includes("w")) x0 += dx; if (d.includes("e")) x1 += dx;
    if (d.includes("n")) y0 += dy; if (d.includes("s")) y1 += dy;
    if (this.keepAspect(m) && b.w && b.h && d.length === 1) {
      const r = b.w / b.h;
      if (d === "e" || d === "w") y1 = y0 + Math.abs(x1 - x0) / r; else x1 = x0 + Math.abs(y1 - y0) * r;
    }
    if (this.keepAspect(m) && b.w && b.h && d.length === 2) {
      const r = b.w / b.h, nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0);
      if (nw / r > nh) { const h = nw / r; if (d.includes("n")) y0 = y1 - h; else y1 = y0 + h; } else { const ww = nh * r; if (d.includes("w")) x0 = x1 - ww; else x1 = x0 + ww; }
    }
    const nb = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    // The new box's center, from the old frame back to the scene.
    const c = rotate({ x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, center(b), a);
    const el = clone(orig);
    el.width = nb.w; el.height = nb.h; el.x = c.x - nb.w / 2; el.y = c.y - nb.h / 2;
    const l = isShape(el) && this.doc.labelOf(el); if (l) this.fitHost(el, l);
    this.livePut(el);
  }

  rotateBy(deg) {
    const els = this.selected().filter(e => !isLabel(e) && this.doc.editable(e)); if (!els.length) return;
    const c = this.selCenter(), da = deg * Math.PI / 180;
    this.transact(tx => {
      for (const e of els) {
        rotateAbout(tx.get(e.id), clone(e), c, da);
        const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).angle = tx.get(e.id).angle;
      }
    });
  }
  resetRotation() {
    const els = this.selected().filter(e => !isLinear(e) && angleOf(e)); if (!els.length) return;
    this.transact(tx => { for (const e of els) { tx.get(e.id).angle = 0; const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).angle = 0; } });
  }

  // Grow a shape downward until its label fits (Excalidraw does the same).
  fitHost(host, label) {
    if (!label?.text) return;
    const need = labelHostHeight(label, host);
    if (Math.abs(host.height) < need) host.height = need;
  }

  movePoint(g, w) {
    const o = g.orig.values().next().value, c = clone(o), at = this.snapPoint(w);
    c.points[g.h.i] = [at.x - o.x, at.y - o.y];
    // Dragging an end off its shape unbinds it for now; rebind() on release.
    if (g.h.i === 0) c.startBinding = null;
    if (g.h.i === c.points.length - 1) c.endBinding = null;
    this.livePut(c);
  }

  rebind(el, i) {
    if (!el || (i !== 0 && i !== el.points.length - 1)) return;
    const p = { x: el.x + el.points[i][0], y: el.y + el.points[i][1] };
    const other = i === 0 ? el.endBinding?.elementId : el.startBinding?.elementId;
    const s = shapeAt(this.doc, p, other);
    const b = s ? { elementId: s.id, focus: 0, gap: 6 } : null;
    if (i === 0) el.startBinding = b; else el.endBinding = b;
  }

  dragCreate(g, w, m) {
    const el = g.el, at = this.snapPoint(w);
    if (isShape(el) || el.type === "frame") {
      el.width = at.x - g.start.x; el.height = at.y - g.start.y;
      if (m.shift) { const s = Math.max(Math.abs(el.width), Math.abs(el.height)); el.width = Math.sign(el.width || 1) * s; el.height = Math.sign(el.height || 1) * s; }
    } else if (el.type === "freedraw") {
      const last = el.points[el.points.length - 1], q = [w.x - el.x, w.y - el.y];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) * this.view.scale < 1.5) return;
      el.points.push(q);
    } else {
      let q = [at.x - el.x, at.y - el.y];
      if (m.shift) { const a = Math.round(Math.atan2(q[1], q[0]) / (Math.PI / 12)) * (Math.PI / 12), r = Math.hypot(q[0], q[1]); q = [Math.cos(a) * r, Math.sin(a) * r]; }
      el.points[el.points.length - 1] = q;
    }
    this.livePut(el);
  }

  finishCreate(g, p) {
    const el = g.el;
    const dragged = Math.hypot(p.x - g.p.x, p.y - g.p.y) >= DRAG_SLOP;
    if (isShape(el) || el.type === "frame") {
      if (!dragged || (Math.abs(el.width) < 4 && Math.abs(el.height) < 4)) {   // a click: default size
        const d = el.type === "frame" ? [320, 240] : [140, 80];
        el.width = d[0]; el.height = d[1]; el.x -= d[0] / 2; el.y -= d[1] / 2;
      }
    } else if (el.type === "arrow" || el.type === "line") {
      if (!dragged) {   // a click: keep adding points until double-click / Enter
        this.g = { kind: "poly", el, before: g.before };
        el.points[1] = [0, 0];
        return this.changed();
      }
      this.bindEnd(el);
    } else if (el.type === "freedraw" && el.points.length < 2) el.points.push([0.5, 0.5]);
    this.endCreate(el, g.before);
  }

  bindEnd(el) {
    const end = el.points[el.points.length - 1];
    const s = shapeAt(this.doc, { x: el.x + end[0], y: el.y + end[1] }, el.startBinding?.elementId);
    if (s) el.endBinding = { elementId: s.id, focus: 0, gap: 6 };
  }

  finishPoly() {
    const g = this.g; if (!g || g.kind !== "poly") return;
    this.g = null;
    const el = g.el;
    // Drop the trailing rubber-band point and any zero-length tail.
    while (el.points.length > 2 && dist(el.points[el.points.length - 1], el.points[el.points.length - 2]) < 4) el.points.pop();
    if (el.points.length < 2 || dist(el.points[0], el.points[el.points.length - 1]) < 4 && el.points.length === 2) {
      const dead = { ...clone(el), isDeleted: true }; this.livePut(dead); return this.changed();
    }
    this.bindEnd(el);
    this.endCreate(el, g.before);
  }

  endCreate(el, before) {
    normalize(el);
    const dirty = new Map([[el.id, clone(el)]]);
    // Bound shapes learn about the arrow (Excalidraw's boundElements).
    for (const b of [el.startBinding, el.endBinding]) {
      const t = b && this.doc.get(b.elementId); if (!t) continue;
      if (!before.has(t.id)) before.set(t.id, clone(t));
      const c = dirty.get(t.id) ?? clone(t);
      c.boundElements = (c.boundElements ?? []).filter(x => x.id !== el.id).concat([{ id: el.id, type: "arrow" }]);
      dirty.set(t.id, c);
    }
    this.commitGesture(before, dirty);
    this.select([el.id]);
    if (!this.toolLock && el.type !== "freedraw") this.tool = "select";
  }

  eraseAt(from, to) {
    for (const el of this.doc.visible()) {
      if (this.erasing.has(el.id) || isLabel(el) || !this.doc.editable(el)) continue;
      let hit = hits(this.doc, el, to, this.tol() * 1.5);
      if (!hit && isLinear(el)) { const pts = resolvedPoints(this.doc, el); for (let i = 1; i < pts.length && !hit; i++) hit = segmentsIntersect([from.x, from.y], [to.x, to.y], pts[i - 1], pts[i]); }
      if (hit) this.erasing.add(el.id);
    }
    this.changed();
  }

  finishErase() {
    const ids = [...this.erasing]; this.erasing.clear();
    if (ids.length) this.deleteIds(ids);
    this.changed();
  }

  // ── snapping ───────────────────────────────────────────────────────────

  get grid() { return this.doc.appState.herdr.grid ?? 0; }
  get snapOn() { return this.doc.appState.herdr.snap !== false; }

  snapPoint(w) {
    if (!this.grid) return w;
    const g = this.grid; return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
  }

  // Snap a moving box to the grid, or to other elements' edges and centers (with guides).
  snapMove(box, dx, dy, skip) {
    this.guides = [];
    if (!box) return { dx, dy };
    if (this.grid) { const g = this.grid; return { dx: Math.round((box.x + dx) / g) * g - box.x, dy: Math.round((box.y + dy) / g) * g - box.y }; }
    if (!this.snapOn) return { dx, dy };
    const tol = SNAP / this.view.scale;
    const xs = [box.x, box.x + box.w / 2, box.x + box.w].map(v => v + dx), ys = [box.y, box.y + box.h / 2, box.y + box.h].map(v => v + dy);
    let bx = null, by = null;
    for (const el of this.doc.visible()) {
      if (skip.has(el.id) || isLabel(el)) continue;
      const b = bounds(el), tx = [b.x, b.x + b.w / 2, b.x + b.w], ty = [b.y, b.y + b.h / 2, b.y + b.h];
      for (const a of xs) for (const t of tx) { const d = t - a; if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: t, b }; }
      for (const a of ys) for (const t of ty) { const d = t - a; if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: t, b }; }
    }
    if (bx) { dx += bx.d; this.guides.push({ x: bx.at, y0: Math.min(box.y + dy, bx.b.y), y1: Math.max(box.y + dy + box.h, bx.b.y + bx.b.h) }); }
    if (by) { dy += by.d; this.guides.push({ y: by.at, x0: Math.min(box.x + dx, by.b.x), x1: Math.max(box.x + dx + box.w, by.b.x + by.b.w) }); }
    return { dx, dy };
  }

  // ── text ───────────────────────────────────────────────────────────────

  beginText(target, w) {
    let el, isNew = false;
    if (target && (isShape(target) || isLinear(target)) && target.type !== "freedraw" && target.type !== "frame") {
      el = this.doc.labelOf(target);
      if (!el) {
        isNew = true;
        const c = center(bbox(target));
        el = this.newEl("text", { x: c.x, y: c.y, containerId: target.id, textAlign: "center", verticalAlign: "middle", strokeColor: target.strokeColor, fontSize: this.style.fontSize, fontFamily: this.style.fontFamily });
      }
    } else if (target?.type === "frame") {
      this.text = { id: target.id, value: target.name ?? "", isNew: false, frame: true }; this.select([target.id]); return this.changed();
    } else if (target?.type === "text") el = target;
    else { isNew = true; el = this.newEl("text", { x: w.x, y: w.y - this.style.fontSize * 0.6, strokeColor: this.style.strokeColor, fontSize: this.style.fontSize, fontFamily: this.style.fontFamily, opacity: this.style.opacity }); }
    this.text = { id: el.id, value: el.text ?? "", isNew, draft: isNew ? el : null };
    if (!this.toolLock) this.tool = "select";
    this.changed();
  }

  // Where the adapter should put its text input (screen px).
  textBox() {
    const t = this.text; if (!t) return null;
    const el = t.draft ?? this.doc.get(t.id); if (!el) return null;
    const host = el.containerId ? this.doc.get(el.containerId) : t.frame ? el : null;
    const b = host ? bbox(host) : { x: el.x, y: el.y, w: Math.max(200, textSize(t.value || "M", el.fontSize).w), h: el.fontSize * 1.4 };
    const a = this.toScreen(b), s = this.view.scale;
    if (t.frame) return { x: a.x, y: a.y - 26, w: Math.max(160, b.w * s), h: 24, size: 13, align: "left" };
    const lines = Math.max(1, String(t.value).split("\n").length), h = Math.max(36, lines * el.fontSize * s * 1.3 + 14);
    return { x: a.x, y: host ? a.y + (b.h * s) / 2 - h / 2 : a.y, w: Math.max(160, b.w * s), h, size: Math.max(12, el.fontSize * s), align: host ? "center" : "left", lines };
  }

  setText(v) { if (this.text) { this.text.value = v; this.changed(); } }

  commitText() {
    const t = this.text; if (!t) return;
    this.text = null;
    const value = t.value.replace(/\s+$/, "");
    if (t.frame) { this.transact(tx => { tx.get(t.id).name = value || null; }); return; }
    if (!value) {
      if (!t.isNew) this.deleteIds([t.id]);
      return this.changed();
    }
    this.transact(tx => {
      const el = t.isNew ? tx.add(t.draft) : tx.get(t.id);
      if (!el) return;
      el.text = el.originalText = value;
      const s = textSize(value, el.fontSize, el.lineHeight); el.width = s.w; el.height = s.h;
      if (el.containerId) {
        const host = tx.get(el.containerId);
        if (host && t.isNew) host.boundElements = (host.boundElements ?? []).concat([{ id: el.id, type: "text" }]);
        if (host && isShape(host)) this.fitHost(host, el);
      }
    });
    this.select([this.text?.id ?? (this.doc.get(t.id)?.containerId ?? t.id)]);
  }

  cancelText() { this.text = null; this.changed(); }

  // ── commands (keys, toolbars, panels, agents) ──────────────────────────

  deleteIds(ids) {
    this.transact(tx => {
      for (const id of ids) {
        const el = tx.get(id); if (!el) continue;
        el.isDeleted = true;
        if (isShape(el)) { const l = this.doc.labelOf(el); if (l) tx.get(l.id).isDeleted = true; }
        for (const a of this.doc.live()) {
          if (a.startBinding?.elementId === id) tx.get(a.id).startBinding = null;
          if (a.endBinding?.elementId === id) tx.get(a.id).endBinding = null;
          if (isLabel(a) && a.containerId === id) tx.get(a.id).isDeleted = true;
        }
      }
    });
    this.pruneSel(); this.changed();
  }

  // Copies of the selection right where they are (alt-drag), selected instead of the originals.
  duplicateInPlace() { const ids = this.cloneSelection(0, 0, false); this.sel = new Set(this.sel); return ids; }

  cloneSelection(dx, dy, selectCopies = true) {
    const els = this.selected(); if (!els.length) return [];
    const map = new Map(), groupMap = new Map(), out = [];
    const all = [...els];
    for (const el of els) { const l = isShape(el) && this.doc.labelOf(el); if (l) all.push(l); }
    for (const el of all) map.set(el.id, newId());
    this.transact(tx => {
      for (const el of all) {
        const c = clone(el); c.id = map.get(el.id); c.x += dx; c.y += dy; c.seed = Math.floor(Math.random() * 2 ** 31); c.version = 0;
        c.groupIds = (c.groupIds ?? []).map(g => { if (!groupMap.has(g)) groupMap.set(g, newId()); return groupMap.get(g); });
        if (c.containerId) c.containerId = map.get(c.containerId) ?? null;
        c.boundElements = (c.boundElements ?? []).filter(b => map.has(b.id)).map(b => ({ ...b, id: map.get(b.id) }));
        for (const k of ["startBinding", "endBinding"]) if (c[k]) c[k] = map.has(c[k].elementId) ? { ...c[k], elementId: map.get(c[k].elementId) } : null;
        c.customData = { ...c.customData, z: (c.customData?.z ?? 0) + 0.5 };
        tx.add(c); out.push(c.id);
      }
    });
    if (selectCopies) this.select(out.filter(id => !isLabel(this.doc.get(id))));
    return out;
  }

  copy() {
    const els = this.selected(); if (!els.length) return null;
    const all = [...els]; for (const el of els) { const l = isShape(el) && this.doc.labelOf(el); if (l) all.push(l); }
    // Excalidraw's clipboard format, so pasting into excalidraw.com works too.
    const files = {};
    for (const el of all) if (el.type === "image" && this.doc.files[el.fileId]) files[el.fileId] = this.doc.files[el.fileId];
    this.clipboard = JSON.stringify({ type: "excalidraw/clipboard", elements: all.map(clone), files });
    return this.clipboard;
  }

  // Image blobs by file id ({ id, mimeType, dataURL, created }). Add-only, outside undo:
  // undoing an insert deletes the element and leaves its file, as Excalidraw does.
  addFiles(files) {
    const op = { files };
    if (this.doc.apply(op).length) this.onOp(op);
  }

  // Put an image on the board, centered at `at` (scene coords), scaled down to fit
  // 60% of the view. `file`: { id, mimeType, dataURL, width, height } (natural px).
  // Returns the new element's id.
  addImage(file, at = this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 })) {
    const { id, mimeType, dataURL } = file;
    const files = this.doc.files[id] ? undefined : { [id]: { id, mimeType, dataURL, created: this.clock() } };
    let w = Math.max(1, +file.width || 200), h = Math.max(1, +file.height || 150);
    const k = Math.min(1, (this.size.w * 0.6) / this.view.scale / w, (this.size.h * 0.6) / this.view.scale / h);
    w *= k; h *= k;
    const el = this.newEl("image", { fileId: id, x: at.x - w / 2, y: at.y - h / 2, width: w, height: h, opacity: 100 });
    this.transact(tx => tx.add(el), { files });
    this.select([el.id]);
    return el.id;
  }

  // A Mermaid flowchart becomes editable shapes, laid out, centered at `at`; returns the new ids.
  importMermaid(src, at = this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 }), { elbow = this.style.elbowed } = {}) {
    const { elements } = mermaidToElements(src, { layer: this.activeLayer, z: this.doc.maxZ(this.activeLayer), elbow });
    const box = unionBox(elements.filter(e => e.type !== "text").map(bbox));
    const dx = at.x - (box.x + box.w / 2), dy = at.y - (box.y + box.h / 2);
    this.transact(tx => { for (const e of elements) { e.x += dx; e.y += dy; tx.add(e); } });
    const ids = elements.filter(e => !isLabel(e)).map(e => e.id);
    this.select(ids);
    // Bring it all into view if it doesn't fit (Excalidraw zooms to imported content too).
    const nb = unionBox(this.selected().map(bounds)), a = this.toScreen(nb), z = this.toScreen({ x: nb.x + nb.w, y: nb.y + nb.h });
    if (a.x < 0 || a.y < 0 || z.x > this.size.w || z.y > this.size.h) this.fit(this.selected());
    return ids;
  }

  paste(text = this.clipboard, at) {
    if (isMermaid(text)) { try { this.importMermaid(text, at); this.flash = "imported Mermaid"; } catch (e) { this.flash = String(e.message ?? e); } return; }
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!data?.elements?.length) {
      if (text && typeof text === "string") { const c = at ?? this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 }); this.beginText(null, c); this.text.value = text; this.commitText(); }
      return;
    }
    const els = data.elements.filter(e => !e.isDeleted), box = unionBox(els.filter(e => !isLabel(e)).map(bbox));
    const target = at ?? this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 });
    const dx = target.x - (box.x + box.w / 2), dy = target.y - (box.y + box.h / 2);
    if (data.files && typeof data.files === "object") this.addFiles(data.files);
    const idMap = new Map(els.map(e => [e.id, newId()])), z = this.doc.maxZ(this.activeLayer);
    const out = [];
    this.transact(tx => {
      els.forEach((e, i) => {
        const c = clone(e); c.id = idMap.get(e.id); c.x += dx; c.y += dy; c.version = 0;
        if (c.containerId) c.containerId = idMap.get(c.containerId) ?? null;
        c.boundElements = (c.boundElements ?? []).filter(b => idMap.has(b.id)).map(b => ({ ...b, id: idMap.get(b.id) }));
        for (const k of ["startBinding", "endBinding"]) if (c[k]) c[k] = idMap.has(c[k].elementId) ? { ...c[k], elementId: idMap.get(c[k].elementId) } : null;
        c.customData = { ...(c.customData ?? {}), layer: this.activeLayer, z: z + 1 + i };
        tx.add(c); out.push(c);
      });
    });
    this.select(out.filter(e => !isLabel(e)).map(e => e.id));
  }

  group() {
    const els = this.selected(); if (els.length < 2) return;
    const g = newId();
    this.transact(tx => { for (const e of els) tx.get(e.id).groupIds = [...(e.groupIds ?? []), g]; });
  }
  ungroup() {
    this.transact(tx => { for (const e of this.selected()) if (e.groupIds?.length) tx.get(e.id).groupIds = e.groupIds.slice(0, -1); });
  }

  // Z-order within each element's layer.
  reorder(how) {
    const els = this.selected(); if (!els.length) return;
    this.transact(tx => {
      for (const e of els) {
        const layer = layerOf(e), peers = this.doc.live().filter(x => layerOf(x) === layer && !isLabel(x));
        const i = peers.findIndex(x => x.id === e.id), z = zOf(e);
        let nz = z;
        if (how === "front") nz = this.doc.maxZ(layer) + 1;
        if (how === "back") nz = this.doc.minZ(layer) - 1;
        if (how === "forward" && i < peers.length - 1) nz = zOf(peers[i + 1]) + 0.5;
        if (how === "backward" && i > 0) nz = zOf(peers[i - 1]) - 0.5;
        tx.get(e.id).customData = { ...e.customData, z: nz };
      }
    });
  }

  align(how) {
    const els = this.selected().filter(e => !isLabel(e)); if (els.length < 2) return;
    const B = unionBox(els.map(bounds));
    this.transact(tx => {
      for (const e of els) {
        const b = bounds(e); let dx = 0, dy = 0;
        if (how === "left") dx = B.x - b.x; if (how === "right") dx = B.x + B.w - (b.x + b.w); if (how === "hcenter") dx = B.x + B.w / 2 - (b.x + b.w / 2);
        if (how === "top") dy = B.y - b.y; if (how === "bottom") dy = B.y + B.h - (b.y + b.h); if (how === "vcenter") dy = B.y + B.h / 2 - (b.y + b.h / 2);
        this.shift(tx, e, dx, dy);
      }
    });
  }

  distribute(axis) {
    const els = this.selected().filter(e => !isLabel(e)); if (els.length < 3) return;
    const k = axis === "h" ? ["x", "w"] : ["y", "h"];
    const items = els.map(e => ({ e, b: bounds(e) })).sort((a, b) => a.b[k[0]] - b.b[k[0]]);
    const span = items[items.length - 1].b[k[0]] + items[items.length - 1].b[k[1]] - items[0].b[k[0]];
    const gap = (span - items.reduce((s, i) => s + i.b[k[1]], 0)) / (items.length - 1);
    this.transact(tx => {
      let at = items[0].b[k[0]];
      for (const { e, b } of items) { const d = at - b[k[0]]; this.shift(tx, e, axis === "h" ? d : 0, axis === "v" ? d : 0); at += b[k[1]] + gap; }
    });
  }

  shift(tx, e, dx, dy) {
    if (!dx && !dy) return;
    const c = tx.get(e.id); c.x += dx; c.y += dy;
    const l = isShape(e) && this.doc.labelOf(e); if (l) { const cl = tx.get(l.id); cl.x += dx; cl.y += dy; }
  }

  nudge(dx, dy) { const els = this.selected().filter(e => this.doc.editable(e)); if (els.length) this.transact(tx => els.forEach(e => this.shift(tx, e, dx, dy))); }

  // Style the selection, and remember it for the next element drawn.
  setStyle(patch) {
    Object.assign(this.style, patch);
    const els = this.selected(); if (!els.length) return this.changed();
    this.transact(tx => {
      for (const e of els) {
        const c = tx.get(e.id);
        for (const [k, v] of Object.entries(patch)) {
          if (k === "fontSize") {
            if (c.type === "text") { c.fontSize = v; const host = c.containerId && tx.get(c.containerId); if (host && isShape(host)) this.fitHost(host, c); }
            const l = isShape(e) && this.doc.labelOf(e);
            if (l) { const cl = tx.get(l.id); cl.fontSize = v; this.fitHost(c, cl); }
            continue;
          }
          if (k === "fontFamily") {
            if (c.type === "text") c.fontFamily = v;
            const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).fontFamily = v;
            continue;
          }
          if ((k === "backgroundColor" || k === "fillStyle") && !isShape(c)) continue;
          if (k === "roundness" && !["rectangle", "diamond", "arrow", "line"].includes(c.type)) continue;
          if (k === "elbowed") {   // arrow type: elbow arrows are routed; turning it off keeps the current bends
            if (c.type !== "arrow") continue;
            if (!v && c.elbowed) { const pts = resolvedPoints(this.doc, e); c.x = pts[0][0]; c.y = pts[0][1]; c.points = pts.map(p => [p[0] - c.x, p[1] - c.y]); }
            c.elbowed = v; if (v) c.roundness = null;
            continue;
          }
          if (k === "endArrowhead" || k === "startArrowhead") { if (c.type === "arrow" || c.type === "line") c[k] = v; continue; }
          c[k] = v;
          if (k === "strokeColor") { const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).strokeColor = v; }
        }
      }
    });
  }
  cycle(key, list) { const cur = this.selected()[0]?.[key] ?? this.style[key]; this.setStyle({ [key]: list[(list.indexOf(cur) + 1) % list.length] }); }

  toggleLock() { const els = this.selected(); if (els.length) { const v = !els.every(e => e.locked); this.transact(tx => els.forEach(e => { tx.get(e.id).locked = v; })); } }

  // ── layers (Photoshop-style: order, visibility, lock, opacity) ─────────

  layerOps(layers) { this.setAppState({ layers }); }
  addLayer(name) {
    const id = newId(), layers = [...this.doc.layers, { ...defaultLayer(this.doc.layers.length + 1, id), name: name ?? `Layer ${this.doc.layers.length + 1}` }];
    this.layerOps(layers); this.activeLayer = id; this.changed(); return id;
  }
  updateLayer(id, patch) { this.layerOps(this.doc.layers.map(l => (l.id === id ? { ...l, ...patch } : l))); if (patch.visible === false || patch.locked) { for (const e of this.selected()) if (layerOf(e) === id) this.sel.delete(e.id); } }
  moveLayer(id, dir) {
    const ls = [...this.doc.layers], i = ls.findIndex(l => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= ls.length) return;
    [ls[i], ls[j]] = [ls[j], ls[i]]; this.layerOps(ls);
  }
  deleteLayer(id) {
    if (this.doc.layers.length < 2) return;
    const ls = this.doc.layers.filter(l => l.id !== id), into = ls[Math.max(0, this.doc.layers.findIndex(l => l.id === id) - 1)].id;
    const els = this.doc.live().filter(e => layerOf(e) === id);
    if (els.length) this.transact(tx => els.forEach(e => { tx.get(e.id).customData = { ...e.customData, layer: into }; }));
    this.layerOps(ls); this.fixLayer();
  }
  moveToLayer(id) {
    const els = this.selected(); if (!els.length) return;
    let z = this.doc.maxZ(id);
    this.transact(tx => { for (const e of els) { tx.get(e.id).customData = { ...e.customData, layer: id, z: ++z }; const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).customData = { ...l.customData, layer: id, z }; } });
  }

  // ── animation ──────────────────────────────────────────────────────────

  // Give the selection a preset, staggered in selection order after what's already animated.
  animate(preset, { duration = 600, stagger = 150, start } = {}) {
    const els = this.selected(); if (!els.length || !PRESETS[preset]) return;
    let t = start ?? timelineEnd(this.doc.live().filter(e => !this.sel.has(e.id)));
    this.transact(tx => {
      for (const e of els) {
        const anim = { preset, start: t, duration };
        tx.get(e.id).customData = { ...e.customData, anim };
        const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).customData = { ...l.customData, anim };
        t += stagger;
      }
    });
  }
  clearAnimation() { const els = this.selected(); this.transact(tx => els.forEach(e => { const c = tx.get(e.id); const { anim, ...rest } = c.customData ?? {}; c.customData = rest; })); }
  duration() { return Math.max(timelineEnd(this.doc.live()), 1); }
  playToggle() {
    if (this.play) { this.scrub = this.time(); this.play = null; }
    else { const from = this.scrub != null && this.scrub < this.duration() ? this.scrub : 0; this.play = { t0: this.clock(), from }; }
    this.changed();
  }
  stopPlay() { this.play = null; this.scrub = null; this.changed(); }
  time() {
    if (this.play) { const t = this.play.from + this.clock() - this.play.t0; if (t > this.duration() + 400) { this.play = null; this.scrub = null; return null; } return t; }
    return this.scrub;
  }

  // Adapters call this on a timer only while it says so (laser fading, playback).
  needsTick() { return !!this.play || this.laser.length > 0; }
  tick() {
    const now = this.clock();
    if (this.laser.length) this.laser = this.laser.filter(p => now - p.t < 900);
    this.changed();
  }

  // ── view ───────────────────────────────────────────────────────────────

  fit(els = this.doc.visible().filter(e => !isLabel(e)), pad = 40) {
    if (!els.length) { this.view = { x: 40, y: 40, scale: 1 }; return this.changed(); }
    const b = unionBox(els.map(bounds));
    const scale = Math.max(0.1, Math.min(1, Math.min((this.size.w - pad * 2) / (b.w || 1), (this.size.h - pad * 2) / (b.h || 1))));
    this.view = { scale, x: (this.size.w / scale - b.w) / 2 - b.x, y: (this.size.h / scale - b.h) / 2 - b.y };
    this.changed();
  }

  // ── keys ───────────────────────────────────────────────────────────────

  // `key` as GPUI names it ("a", "backspace", "left", "[", ...); m = { shift, alt, cmd, ctrl }.
  // Returns true when the editor used the key.
  key(key, m = {}) {
    if (this.text) {
      if (key === "escape") { this.commitText(); return true; }
      return false;   // the adapter's text input owns typing
    }
    const k = key.toLowerCase(), mod = m.cmd || m.ctrl;
    if (mod) {
      const act = {
        z: () => (m.shift ? this.redo() : this.undo()), y: () => this.redo(),
        a: () => this.select(this.doc.visible().filter(e => !isLabel(e)).map(e => e.id)),
        d: () => this.cloneSelection(20, 20), c: () => this.copy(), x: () => { if (this.copy()) this.deleteIds([...this.sel]); },
        v: () => this.paste(), g: () => (m.shift ? this.ungroup() : this.group()),
        "]": () => this.reorder("front"), "[": () => this.reorder("back"),
        "=": () => this.zoomAt(this.view.scale * 1.2), "-": () => this.zoomAt(this.view.scale / 1.2), 0: () => this.zoomAt(1),
        l: () => m.shift && this.toggleLock(), "'": () => this.setAppState({ grid: this.grid ? 0 : 20 }),
      }[k];
      if (!act) return false;
      act(); return true;
    }
    if (m.shift && k === "1") { this.fit(); return true; }
    if (m.shift && k === "2") { this.fit(this.selected()); return true; }
    if (m.alt) {
      const a = { a: () => this.align("left"), d: () => this.align("right"), w: () => this.align("top"), s: () => this.align("bottom"), h: () => this.align("hcenter"), v: () => this.align("vcenter") }[k];
      if (a) { a(); return true; }
    }
    if (k === "<" || (m.shift && k === ",")) { this.rotateBy(-15); return true; }
    if (k === ">" || (m.shift && k === ".")) { this.rotateBy(15); return true; }
    if (m.shift && k === "h") { this.distribute("h"); return true; }
    if (m.shift && k === "v") { this.distribute("v"); return true; }
    const tool = TOOLS.find(t => t.keys.includes(k));
    if (tool && !m.shift) { this.setTool(tool.id); return true; }
    const arrows = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[k];
    if (arrows) { const s = m.shift ? 20 : this.grid || 2; this.nudge(arrows[0] * s, arrows[1] * s); return true; }
    switch (k) {
      case "backspace": case "delete": this.deleteIds([...this.sel]); return true;
      case "escape": if (this.g?.kind === "poly") this.finishPoly(); else { this.select([]); this.setTool("select"); this.stopPlay(); } return true;
      case "enter": {
        if (this.g?.kind === "poly") { this.finishPoly(); return true; }
        const el = this.selected()[0]; if (el) { this.beginText(el, center(bbox(el))); return true; } return false;
      }
      case "q": this.toolLock = !this.toolLock; this.flash = this.toolLock ? "tool locked" : "tool unlocked"; this.changed(); return true;
      case "c": this.cycle("strokeColor", STROKES); return true;
      case "b": this.cycle("backgroundColor", FILLS); return true;
      case "s": this.cycle("strokeStyle", STYLES); return true;
      case "w": this.cycle("strokeWidth", WIDTHS); return true;
      case "g": this.setStyle({ roughness: (this.selected()[0]?.roughness ?? this.style.roughness) ? 0 : 1 }); return true;
      case "]": this.reorder("forward"); return true;
      case "[": this.reorder("backward"); return true;
      case "space": if (!m.shift) return false; this.playToggle(); return true;   // shift-space plays the timeline
      case "=": this.setStyle({ fontSize: Math.min(96, (this.selectedFont() ?? this.style.fontSize) + 4) }); return true;
      case "-": this.setStyle({ fontSize: Math.max(8, (this.selectedFont() ?? this.style.fontSize) - 4) }); return true;
    }
    return false;
  }
  selectedFont() { const e = this.selected()[0]; if (!e) return null; if (e.type === "text") return e.fontSize; const l = isShape(e) && this.doc.labelOf(e); return l?.fontSize ?? null; }

  setTool(id) { if (this.g?.kind === "poly") this.finishPoly(); this.tool = id; if (id !== "select") this.hover = null; this.changed(); }

  // ── what to paint ──────────────────────────────────────────────────────

  // An element's drawn outline (rotation included), padded, in screen px.
  outlineCmds(el, padPx) {
    const pad = padPx / this.view.scale;
    let pts;
    if (angleOf(el)) {
      const b = bbox(el);
      pts = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen(elToWorld(el, { x, y })));
    } else {
      const b = bbox(el);
      pts = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen({ x, y }));
    }
    return [...pts.map((p, i) => [i ? "L" : "M", p.x, p.y]), ["L", pts[0].x, pts[0].y]];
  }

  displayList(theme) {
    const time = this.time();
    const items = paintScene(this.doc, this.view, theme, { time: time ?? undefined });
    if (this.text) { const hide = this.text.id; for (let i = items.length - 1; i >= 0; i--) if (items[i].id === hide && items[i].t === "text") items.splice(i, 1); }
    if (this.erasing.size) for (const it of items) if (this.erasing.has(it.id)) it.opacity = (it.opacity ?? 1) * 0.25;
    if (time != null) return items;   // playback: the board only
    const P = project(this.view), acc = theme.accent;
    if (this.hover && !this.sel.has(this.hover)) {
      const el = this.doc.get(this.hover);
      if (el) items.push({ t: "path", cmds: this.outlineCmds(el, 4), stroke: withAlpha(acc, 0.45), width: 1, dash: null });
    }
    const els = this.selected();
    if (els.length) {
      if (els.length > 1) for (const e of els) { if (isLabel(e)) continue; items.push({ t: "path", cmds: this.outlineCmds(e, 3), stroke: withAlpha(acc, 0.5), width: 1, dash: [3, 3] }); }
      const hs = this.handles();
      if (!hs.length || hs[0].kind !== "point") {
        const f = this.selFrame(6);
        if (f) items.push({ t: "path", cmds: [["M", f[0].x, f[0].y], ["L", f[1].x, f[1].y], ["L", f[2].x, f[2].y], ["L", f[3].x, f[3].y], ["L", f[0].x, f[0].y]], stroke: acc, width: 1, dash: els.some(e => e.locked) ? [4, 4] : null });
      }
      for (const h of hs) {
        if (h.kind === "rotate") {   // a small circle
          const r = 5, ring = [];
          for (let i = 0; i <= 16; i++) { const t = i / 16 * Math.PI * 2; ring.push([i ? "L" : "M", h.x + Math.cos(t) * r, h.y + Math.sin(t) * r]); }
          items.push({ t: "path", cmds: ring.slice(0, 16), fill: theme.bg });
          items.push({ t: "path", cmds: ring, stroke: acc, width: 1.5, dash: null });
          continue;
        }
        const r = h.kind === "point" ? 5 : 4;
        items.push({ t: "path", cmds: rectCmds(h.x - r, h.y - r, r * 2, r * 2).slice(0, 4), fill: theme.bg });
        items.push({ t: "path", cmds: rectCmds(h.x - r, h.y - r, r * 2, r * 2), stroke: acc, width: 1.5, dash: null });
      }
    }
    if (this.g?.kind === "marquee") {
      const a = P(this.g.start.x, this.g.start.y), z = P(this.g.end.x, this.g.end.y), b = normBox({ x: a[0], y: a[1] }, { x: z[0], y: z[1] });
      items.push({ t: "path", cmds: rectCmds(b.x, b.y, b.w, b.h).slice(0, 4), fill: withAlpha(acc, 0.1) });
      items.push({ t: "path", cmds: rectCmds(b.x, b.y, b.w, b.h), stroke: acc, width: 1, dash: null });
    }
    for (const g of this.guides) {
      const cmds = g.x != null ? [["M", ...P(g.x, g.y0)], ["L", ...P(g.x, g.y1)]] : [["M", ...P(g.x0, g.y)], ["L", ...P(g.x1, g.y)]];
      items.push({ t: "path", cmds, stroke: "#e64980", width: 1, dash: null });
    }
    if (this.laser.length > 1) {
      const now = this.clock();
      for (let i = 1; i < this.laser.length; i++) {
        const a = this.laser[i - 1], b = this.laser[i]; if (b.start) continue;
        const age = Math.min(1, (now - b.t) / 900);
        items.push({ t: "path", cmds: [["M", ...P(a.x, a.y)], ["L", ...P(b.x, b.y)]], stroke: withAlpha("#ff3b30", 1 - age), width: 4 * (1 - age) + 1, dash: null });
      }
    }
    for (const [, peer] of this.peers) {
      if (!peer.cursor) continue;
      const [x, y] = P(peer.cursor.x, peer.cursor.y);
      items.push({ t: "path", cmds: [["M", x, y], ["L", x, y + 16], ["L", x + 4.5, y + 12], ["L", x + 11, y + 12]], fill: peer.color ?? acc });
      items.push({ t: "text", x: x + 10, y: y + 14, text: peer.name ?? "?", size: 11, color: peer.color ?? acc, align: "left", lineHeight: 1.2 });
    }
    return items;
  }
}

// A transaction: copies of elements to change, and what they were before.
class Tx {
  constructor(doc) { this.doc = doc; this.before = new Map(); this.dirty = new Map(); }
  get(id) {
    if (this.dirty.has(id)) return this.dirty.get(id);
    const el = this.doc.getAny(id); if (!el) return null;
    this.before.set(id, clone(el));
    const c = clone(el); this.dirty.set(id, c); return c;
  }
  add(el) { const c = clone(el); this.before.set(c.id, null); this.dirty.set(c.id, c); return c; }
}

function normBox(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
