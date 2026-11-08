// The board in memory, and the one way to change it: apply an op.
//
// An op is { elements?: Element[], appState?: object, files?: object } — whole
// elements, each with a bumped version, a shallow patch of appState.herdr, and
// image blobs by file id (add-only: an id is its content's hash, so it never changes). The same op
// goes to the file, to the server and to every other viewer, so local edits,
// undo, agent edits and remote edits are all one code path.

import { clone, layersOf, layerOf, zOf, isLabel, BASE_LAYER } from "./model.js";

// Does `incoming` win over `current`? Higher version wins; a tie goes to the
// lower versionNonce, so every replica picks the same winner.
export function wins(incoming, current) {
  if (!current) return true;
  if ((incoming.version ?? 0) !== (current.version ?? 0)) return (incoming.version ?? 0) > (current.version ?? 0);
  return (incoming.versionNonce ?? 0) < (current.versionNonce ?? 0);
}

export class Doc {
  constructor(scene) { this.load(scene); }

  load(scene) {
    this.byId = new Map();
    for (const el of scene.elements ?? []) this.byId.set(el.id, el);
    this.appState = { ...(scene.appState ?? {}) };
    this.appState.herdr = { ...(this.appState.herdr ?? {}) };
    this.appState.herdr.layers = layersOf(this.appState);
    this.files = { ...(scene.files ?? {}) };
    this.rev = (this.rev ?? 0) + 1;
    this._sorted = null;
  }

  get(id) { const el = this.byId.get(id); return el && !el.isDeleted ? el : null; }
  getAny(id) { return this.byId.get(id) ?? null; }
  get layers() { return this.appState.herdr.layers; }
  layer(id) { return this.layers.find(l => l.id === id) ?? this.layers[0]; }

  // Live elements in paint order: layer order (first is bottom), then z.
  live() {
    if (!this._sorted) {
      const rank = new Map(this.layers.map((l, i) => [l.id, i]));
      const arr = [...this.byId.values()].filter(e => !e.isDeleted);
      const pos = new Map(arr.map((e, i) => [e.id, i]));
      arr.sort((a, b) => ((rank.get(layerOf(a)) ?? 0) - (rank.get(layerOf(b)) ?? 0)) || (zOf(a) - zOf(b)) || (pos.get(a.id) - pos.get(b.id)));
      this._sorted = arr;
    }
    return this._sorted;
  }

  // Elements a person can see and touch (visible, unlocked layers).
  visible() { const hidden = new Set(this.layers.filter(l => !l.visible).map(l => l.id)); return this.live().filter(e => !hidden.has(layerOf(e))); }
  editable(el) { const l = this.layer(layerOf(el)); return l.visible && !l.locked && !el.locked; }

  labelOf(shape) { for (const el of this.byId.values()) if (!el.isDeleted && isLabel(el) && el.containerId === shape.id) return el; return null; }

  maxZ(layer = BASE_LAYER) { let z = 0; for (const el of this.byId.values()) if (!el.isDeleted && layerOf(el) === layer) z = Math.max(z, zOf(el)); return z; }
  minZ(layer = BASE_LAYER) { let z = 0; for (const el of this.byId.values()) if (!el.isDeleted && layerOf(el) === layer) z = Math.min(z, zOf(el)); return z; }

  // Applies an op. `force` skips the version check (for a local edit that was
  // just built from the current state). Returns the ids that changed.
  apply(op, { force = false } = {}) {
    const changed = [];
    for (const el of op.elements ?? []) {
      if (!force && !wins(el, this.byId.get(el.id))) continue;
      this.byId.set(el.id, clone(el));
      changed.push(el.id);
    }
    for (const [id, f] of Object.entries(op.files ?? {})) {
      if (this.files[id] || !f || typeof f.dataURL !== "string") continue;
      this.files[id] = { ...f, id };
      changed.push("$file:" + id);
    }
    if (op.appState) {
      this.appState.herdr = { ...this.appState.herdr, ...op.appState };
      changed.push("$appState");
    }
    if (changed.length) { this.rev++; this._sorted = null; }
    return changed;
  }

  toScene() {
    // Paint order in the array too, so tools that ignore customData.z get it right.
    const live = this.live(), dead = [...this.byId.values()].filter(e => e.isDeleted);
    return { type: "excalidraw", version: 2, source: "herdr-draw", elements: [...live, ...dead], appState: this.appState, files: this.files };
  }
}
