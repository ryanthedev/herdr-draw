// The library: reusable drawings, in Excalidraw's .excalidrawlib format so libraries move
// between excalidraw.com and here. Read: v2 { libraryItems: [{ id, status, created, name?,
// elements }] } and v1 { library: [[elements], …] }. Written: v2. Items may carry `files`
// for their pictures (a herdr extension: excalidraw.com keeps library pictures elsewhere,
// so it shows them as placeholders). Files come from anywhere: parsing skips what's malformed.

import { newId, clone, isLabel } from "./model.js";

const okElements = els => Array.isArray(els) && els.some(e => e && typeof e === "object" && typeof e.type === "string" && !e.isDeleted);

function cleanItem(raw, i) {
  const elements = (Array.isArray(raw) ? raw : raw?.elements);
  if (!okElements(elements)) return null;
  const item = {
    id: typeof raw?.id === "string" && raw.id ? raw.id : `lib-${i}-${newId()}`,
    status: raw?.status === "published" ? "published" : "unpublished",
    created: Number.isFinite(raw?.created) ? raw.created : Date.now(),
    elements: elements.filter(e => e && typeof e === "object" && typeof e.type === "string" && !e.isDeleted).map(clone),
  };
  if (typeof raw?.name === "string" && raw.name) item.name = raw.name.slice(0, 200);
  if (raw?.files && typeof raw.files === "object") item.files = raw.files;
  return item;
}

export function parseLibrary(text) {
  const data = JSON.parse(text);
  if (data?.type !== "excalidrawlib") return [];
  const raw = Array.isArray(data.libraryItems) ? data.libraryItems : Array.isArray(data.library) ? data.library : [];
  return raw.map(cleanItem).filter(Boolean);
}

export function serializeLibrary(items) {
  return JSON.stringify({ type: "excalidrawlib", version: 2, source: "herdr-draw", libraryItems: items }, null, 2);
}

// New items first (as Excalidraw does); an id already there is not added twice.
export function mergeLibrary(items, incoming) {
  const have = new Set(items.map(i => i.id));
  return [...incoming.filter(i => !have.has(i.id) && have.add(i.id)), ...items];
}

// An item from elements (labels already included); keeps only the files its pictures use.
export function itemFromElements(elements, { name, files = {}, now = Date.now() } = {}) {
  const els = elements.map(clone), used = {};
  for (const e of els) if (e.type === "image" && files[e.fileId]) used[e.fileId] = files[e.fileId];
  const label = els.find(e => isLabel(e) && e.text)?.text ?? els.find(e => e.type === "text" && e.text)?.text;
  const item = { id: newId(), status: "unpublished", created: now, elements: els, name: name ?? (label ? String(label).split("\n")[0].slice(0, 40) : undefined) };
  if (!item.name) delete item.name;
  if (Object.keys(used).length) item.files = used;
  return item;
}
