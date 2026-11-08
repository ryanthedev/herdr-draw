// Library: reusable drawings in Excalidraw's .excalidrawlib format (v1 and v2 read, v2 written).
import { test, expect } from "bun:test";
import { setup, PNG } from "./harness/fixture.js";
import { parseLibrary, serializeLibrary, itemFromElements, mergeLibrary } from "../core/library.js";
import { resolvedPoints } from "../core/geometry.js";

const rect = (id, x, y, extra = {}) => ({ id, type: "rectangle", x, y, width: 100, height: 60, angle: 0, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null, strokeColor: "#1e1e1e", backgroundColor: "transparent", ...extra });

test("reads v2 and v1 libraries; items without an element array are skipped", () => {
  const v2 = JSON.stringify({ type: "excalidrawlib", version: 2, source: "https://excalidraw.com", libraryItems: [
    { id: "a", status: "unpublished", created: 5, name: "Box", elements: [rect("r1", 0, 0)] },
    { id: "bad", status: "unpublished", created: 6, elements: "nope" },
    { id: "deadonly", status: "unpublished", created: 7, elements: [rect("r9", 0, 0, { isDeleted: true })] },
  ] });
  const items = parseLibrary(v2);
  expect(items.map(i => i.id)).toEqual(["a"]);
  expect(items[0]).toMatchObject({ name: "Box", created: 5 });
  const v1 = JSON.stringify({ type: "excalidrawlib", version: 1, library: [[rect("r1", 0, 0)], [rect("r2", 0, 0), rect("r3", 200, 0)], "junk"] });
  const old = parseLibrary(v1);
  expect(old.map(i => i.elements.length)).toEqual([1, 2]);
  expect(new Set(old.map(i => i.id)).size).toBe(2);              // v1 has no ids: each gets one
  expect(() => parseLibrary("{not json")).toThrow();
  expect(parseLibrary(JSON.stringify({ type: "excalidraw", elements: [] }))).toEqual([]);   // not a library
});

test("written as v2, readable back; picture files ride along on the item", () => {
  const items = [itemFromElements([rect("r1", 0, 0)], { name: "One" }), itemFromElements([{ ...rect("i1", 0, 0), type: "image", fileId: "f1" }], { files: { f1: { id: "f1", mimeType: "image/png", dataURL: PNG }, other: { dataURL: PNG } } })];
  const lib = JSON.parse(serializeLibrary(items));
  expect(lib).toMatchObject({ type: "excalidrawlib", version: 2 });
  expect(lib.libraryItems[0]).toMatchObject({ status: "unpublished", name: "One" });
  expect(Object.keys(lib.libraryItems[1].files)).toEqual(["f1"]);   // only the files its pictures use
  expect(parseLibrary(JSON.stringify(lib))[1].files.f1.dataURL).toBe(PNG);
});

test("merging adds new items first and never duplicates an id", () => {
  const a = itemFromElements([rect("r1", 0, 0)]), b = itemFromElements([rect("r2", 0, 0)]);
  expect(mergeLibrary([a], [b, a]).map(i => i.id)).toEqual([b.id, a.id]);
});

test("save the selection (labels and picture files included), insert it twice: fresh ids, bindings kept, centered", () => {
  const t = setup();
  t.key("r"); t.drag([100, 100], [200, 160]); t.dblclick([150, 130]); t.type("Start");
  t.key("r"); t.drag([400, 100], [500, 160]);
  t.key("a"); t.drag([150, 130], [450, 130]);
  t.ed.addImage({ id: "f1", mimeType: "image/png", dataURL: PNG, width: 40, height: 20 }, { x: 300, y: 300 });
  t.key("a", { cmd: true }); t.ed.group();
  const item = t.ed.libraryItem();
  expect(item.name).toBe("Start");
  expect(item.elements.filter(e => e.type === "text").length).toBe(1);   // the label came along
  expect(Object.keys(item.files)).toEqual(["f1"]);

  const u = setup();
  const first = u.ed.insertLibraryItem(item, { x: 1000, y: 1000 });
  const second = u.ed.insertLibraryItem(item, { x: 0, y: 0 });
  expect(first.some(id => second.includes(id))).toBe(false);
  const live = u.ed.doc.live();
  expect(live.length).toBe(item.elements.length * 2);
  expect(u.ed.doc.files.f1.dataURL).toBe(PNG);
  // The arrow in the second copy is bound to that copy's rectangles, and its label to its rectangle.
  const arrow = second.map(id => u.ed.doc.get(id)).find(e => e.type === "arrow");
  expect(second).toContain(arrow.startBinding.elementId);
  expect(second).toContain(arrow.endBinding.elementId);
  const label = u.ed.doc.live().find(e => e.type === "text" && second.includes(e.containerId));
  expect(label.text).toBe("Start");
  // Groups are fresh too: the two copies don't select as one.
  const g1 = u.ed.doc.get(first[0]).groupIds, g2 = u.ed.doc.get(second[0]).groupIds;
  expect(g1.length).toBe(1); expect(g1[0]).not.toBe(g2[0]);
  // Centered at `at`, and the arrow still meets its boxes.
  const xs = second.map(id => u.ed.doc.get(id)).filter(e => e.type !== "text").flatMap(e => [e.x, e.x + e.width]);
  expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0, 0);
  const pts = resolvedPoints(u.ed.doc, arrow);
  expect(pts[0][0]).toBeGreaterThan(u.ed.doc.get(arrow.startBinding.elementId).x + 90);
  expect(u.ed.sel.size).toBeGreaterThan(0);
  // One undo takes the whole insert back.
  u.key("z", { cmd: true });
  expect(second.every(id => !u.ed.doc.get(id))).toBe(true);
});

test("nothing selected: no item", () => {
  expect(setup().ed.libraryItem()).toBeNull();
});
