// The board's data: a superset of the .excalidraw file format (version 2).
// Everything herdr-draw adds lives where Excalidraw keeps foreign data, so the
// file still opens there: per element in `customData` ({ layer, z, anim }),
// per board in `appState.herdr` ({ layers, timeline }).
//
// No imports from Herdr, the DOM or Node: this module runs everywhere.

export const DEFAULT_STROKE = "#1e1e1e";
export const BASE_LAYER = "base";

export const SHAPES = ["rectangle", "ellipse", "diamond", "frame"];
export const LINEAR = ["arrow", "line", "freedraw"];
export const isShape = el => SHAPES.includes(el.type);
export const isLinear = el => LINEAR.includes(el.type);
export const isLabel = el => el.type === "text" && !!el.containerId;
// Images are boxes like shapes, but take no label, fill or stroke: their pixels are in the board's `files`.
export const isImage = el => el.type === "image";
// A box that keeps `angle` and resizes by its corners: shapes and images.
export const isBoxy = el => isShape(el) || isImage(el);

let counter = 0;
export function newId() {
  counter = (counter + 1) % 1679616;
  return Date.now().toString(36) + counter.toString(36).padStart(4, "0") + Math.floor(Math.random() * 1296).toString(36);
}
export const randomInt = () => Math.floor(Math.random() * 2 ** 31);

export function emptyScene() {
  return {
    type: "excalidraw", version: 2, source: "herdr-draw", elements: [],
    appState: { viewBackgroundColor: "#ffffff", herdr: { layers: [defaultLayer()], timeline: { duration: 4000 } } },
    files: {},
  };
}

export function defaultLayer(n = 1, id = BASE_LAYER) {
  return { id, name: `Layer ${n}`, visible: true, locked: false, opacity: 100 };
}

export function makeElement(type, fields = {}) {
  const base = {
    id: newId(), type, x: 0, y: 0, width: 0, height: 0, angle: 0,
    strokeColor: DEFAULT_STROKE, backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: randomInt(), version: 1, versionNonce: randomInt(),
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    customData: { layer: BASE_LAYER, z: 0 },
  };
  if (type === "arrow" || type === "line") Object.assign(base, { points: [[0, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: type === "arrow" ? "arrow" : null });
  if (type === "freedraw") Object.assign(base, { points: [[0, 0]], pressures: [], simulatePressure: true, lastCommittedPoint: null });
  if (type === "text") Object.assign(base, { text: "", originalText: "", fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true });
  if (type === "frame") Object.assign(base, { name: null, strokeWidth: 1 });
  if (type === "image") Object.assign(base, { fileId: null, status: "saved", scale: [1, 1], crop: null, strokeColor: "transparent", roughness: 0 });
  const el = Object.assign(base, fields);
  el.customData = { ...base.customData, ...(fields.customData ?? {}) };
  return el;
}

export const clone = el => JSON.parse(JSON.stringify(el));

// Every change to an element bumps its version: that is how two copies of a
// board decide which edit wins (Excalidraw's own reconcile rule).
export function touch(el) {
  el.version = (el.version ?? 0) + 1;
  el.versionNonce = randomInt();
  el.updated = Date.now();
  return el;
}

export const layerOf = el => el.customData?.layer ?? BASE_LAYER;
export const zOf = el => el.customData?.z ?? 0;

export function layersOf(appState) {
  const l = appState?.herdr?.layers;
  return Array.isArray(l) && l.length ? l : [defaultLayer()];
}

// Text size estimate: there is no text measuring that works in every adapter.
export function textSize(text, fontSize, lineHeight = 1.25) {
  const lines = String(text ?? "").split("\n");
  return { w: Math.max(1, ...lines.map(l => l.length)) * fontSize * 0.56, h: lines.length * fontSize * lineHeight };
}
