// The board picker's logic (core/boards.js).
import { test, expect } from "bun:test";
import { rankBoards, newBoardPath, parseRecent, pushRecent, parseListing, boardName, boardRef, parseRef } from "../core/boards.js";

const H = "/Users/me";
const files = [
  { path: `${H}/boards/Roadmap.excalidraw`, mtime: 100 },
  { path: `${H}/boards/team map.excalidraw`, mtime: 300 },
  { path: `${H}/repos/app/docs/architecture.excalidraw`, mtime: 200 },
  { path: `${H}/repos/app/docs/arch-old.excalidraw`, mtime: 50 },
];

test("no query: recent first (newest first), then the rest newest first", () => {
  const rows = rankBoards("", files, [`${H}/boards/Roadmap.excalidraw`], { home: H });
  expect(rows.map(r => r.name)).toEqual(["Roadmap", "team map", "architecture", "arch-old"]);
  expect(rows[0].recent).toBe(true);
  expect(rows[2].folder).toBe("~/repos/app/docs");
});

test("a query ranks names over folders, prefixes over scattered letters", () => {
  expect(rankBoards("arch", files, [], { home: H }).map(r => r.name)).toEqual(["arch-old", "architecture"]);
  expect(rankBoards("map", files, [], { home: H })[0].name).toBe("team map");          // word start
  expect(rankBoards("rdmp", files, [], { home: H })[0].name).toBe("Roadmap");          // letters in order
  expect(rankBoards("docs", files, [], { home: H }).map(r => r.name).sort()).toEqual(["arch-old", "architecture"]);   // by folder
  expect(rankBoards("zzz", files, [], { home: H })).toEqual([]);
});

test("a recent board that's not in the listing still shows (another folder)", () => {
  const rows = rankBoards("", files, [`/tmp/elsewhere/x.excalidraw`], { home: H });
  expect(rows[0].path).toBe("/tmp/elsewhere/x.excalidraw");
});

test("new board names: readable, safe, never an existing file", () => {
  const taken = new Set([`${H}/boards/Plan.excalidraw`, `${H}/boards/Plan 2.excalidraw`]);
  expect(newBoardPath(`${H}/boards`, "Plan", taken)).toBe(`${H}/boards/Plan 3.excalidraw`);
  expect(newBoardPath(`${H}/boards`, "Q3 / roadmap: draft")).toBe(`${H}/boards/Q3 - roadmap- draft.excalidraw`);
  expect(newBoardPath(`${H}/boards`, "../../etc/passwd")).toBe(`${H}/boards/etc-passwd.excalidraw`);
  expect(newBoardPath(`${H}/boards`, "  ")).toBe(`${H}/boards/Untitled.excalidraw`);
  expect(newBoardPath(`${H}/boards`, "notes.excalidraw")).toBe(`${H}/boards/notes.excalidraw`);
});

test("recent list and listing parse safely", () => {
  expect(parseRecent("not json")).toEqual([]);
  expect(parseRecent(JSON.stringify(["/a.excalidraw", 3, "/b.txt"]))).toEqual(["/a.excalidraw"]);
  expect(pushRecent(["/a.excalidraw", "/b.excalidraw"], "/b.excalidraw")).toEqual(["/b.excalidraw", "/a.excalidraw"]);
  expect(pushRecent(Array.from({ length: 40 }, (_, i) => `/${i}.excalidraw`), "/new.excalidraw").length).toBe(30);
  expect(parseListing("1700000000 /x/a b.excalidraw\ngarbage\n12 /y/c.png\n")).toEqual([{ path: "/x/a b.excalidraw", mtime: 1700000000 }]);
  expect(boardName("/x/My Board.excalidraw")).toBe("My Board");
});

test("boards on another machine: refs round-trip, rank with the rest, show their machine", () => {
  const ref = boardRef("/Users/w/repos/booking/docs/j.excalidraw", "ska");
  expect(ref).toBe("ska:/Users/w/repos/booking/docs/j.excalidraw");
  expect(parseRef(ref)).toEqual({ machine: "ska", path: "/Users/w/repos/booking/docs/j.excalidraw" });
  expect(parseRef("/Users/me/b.excalidraw")).toEqual({ machine: null, path: "/Users/me/b.excalidraw" });
  expect(boardRef("/x.excalidraw")).toBe("/x.excalidraw");
  expect(parseRecent(JSON.stringify([ref, "nope"]))).toEqual([ref]);
  const rows = rankBoards("booking", files, [ref], { home: H, homes: { ska: "/Users/w" } });
  expect(rows[0]).toMatchObject({ path: ref, name: "j", folder: "ska: ~/repos/booking/docs", recent: true });
});
