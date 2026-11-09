# Resume note: herdr-draw (2026-11-08)

For the next session picking this up. Read `CLAUDE.md` first (architecture, ports, dev loop, gotchas).

## Where it stands

- All work is committed locally on `main` and **not pushed** (no remote yet). Latest: third session (see `git log`).
- `bun test`: 133 tests, all passing. Snapshots in `test/out/*.png`.
- The person's install (`~/.config/herdr-app/mods/herdr-draw`, and `drawh` on PATH via `~/.local/bin/drawh`) is **behind**: see below.

Built so far (commit order):
1. Core / adapter split, headless test rig (fake GPUI with expiring contexts and a focus model), SVG export.
2. Fixes: text focus, fit ≤ 100%, SVG export escaping, drag from inside a selection, select unfilled boxes from inside.
3. Multi-line text; labels wrap inside shapes; shapes grow to fit.
4. Rotation (handle, keys `<` `>`, rotated hit/resize/binding); Excalidraw Enter keys (Enter = new line, ⌘Enter / Esc = finish), verified live.
5. Mermaid flowchart import (paste, or `drawh mermaid`), layered layout, subgraph frames.
6. Excalidraw fidelity: rounded corners, hachure / cross-hatch, every arrowhead type, font families.
7. Elbow arrows with obstacle-avoiding routes; hatch work bounded.
8. Images (2026-11-08, second session): Excalidraw `image` elements + `files`; drop or ⌘V in the pane, `drawh image` for agents;
   aspect-locked resize (shift frees), copy/paste with files, SVG export embeds them. Board I/O now handles files over 1 MiB
   (`adapters/herdr/io.js`): Herdr's `readTextFile` caps at 1 MiB, which photo boards pass at once.
9. PNG export, library (2026-11-08, second session).
10. Third session (2026-11-08): files open right in excalidraw.com (elbow `fixedPoint`s, label boxes, drawh settles arrows and
    grows shapes), arrow labels travel with copy/duplicate/library, per-glyph text widths for the pane's fonts, boards over
    8 MiB open. Checked against the real excalidraw.com with `scripts/excalidraw-probe.mjs` and live in the isolated Herdr.

## Main Herdr window (the person's): installed build is behind

`~/.config/herdr-app/mods/herdr-draw` holds the library build (matches `bff4afc`), checked 2026-11-08 by comparing files.
Everything after it (elbow fixedPoints, label boxes, arrow labels in copy/library, and this session's later work) is **not
installed**: sessions don't touch the person's window. To install: from a clean tree, `env -u HERDR_APP_HOME sh scripts/dev-sync.sh`
(a Claude shell here may have `HERDR_APP_HOME=~/.cache/hdt`, which would install into the test home instead), then reopen the
board pane (a rebuilt mod can fail to reload in place; see CLAUDE.md). The board pane's id is in
`~/.local/state/herdr-core/default/docs.json` (`herdr-app ls` lists terminals only).

## How to verify in real Herdr (never the person's window)

Isolated home `~/.cache/hdt` already exists (layout `drawtest` shows only the board, file `~/.cache/hdt/t.excalidraw`):

```sh
H=$HOME/.cache/hdt
rsync -a --delete ~/repos/herdr-draw/build/herdr-draw/ $H/mods/herdr-draw/   # after scripts/build.sh
echo '{"layout":"drawtest","frame.welcomed":"finished"}' > $H/shared.json     # stray keys can switch layouts
open -g -n -a Herdr --env HERDR_APP_HOME=$H; sleep 6
HERDR_APP_HOME=$H herdr-app status            # expect "layout": "drawtest", "errors": []
HERDR_APP_HOME=$H herdr-app shot out.png      # board is centered: crop the middle, not the left
HERDR_APP_HOME=$H herdr-app do herdr-draw.write   # starts a text edit (fit / play also exist)
# key input: thegrid input_key_press with that window's id only
kill <pid whose env has HERDR_APP_HOME=$H>    # find it with: ps eww -p PID | grep HERDR_APP_HOME
```

Window `31533` / `~/.cache/eht` belongs to the engram agent: leave it alone.

## Next gaps, most valuable first

1. **Image loose ends.** Not verified live: ⌘V of a clipboard picture (osascript «class PNGf»), drag-and-drop (`on_drop`), and the
   pane's own save of a >1 MiB board (tested headless with real shell commands only). theGrid key presses to the test window
   (id from `window_find --pid`) did not reach the pane, even after `herdr-app do herdr-draw.focus`; find another way before retrying.
   Boards over 8 MiB (exec's output cap) now open: perl splits them
   into character-safe parts read with readTextFile (third session; verified live with a 9.4 MB photo board, an agent's
   write picked up while open). Limit 64 MiB.
   Verified (2026-11-08, probe): a drawh board with a PNG and a JPEG opens in excalidraw.com with both pictures, and an arrow
   bound to a picture follows it when dragged there.
   The image cache is named by the SHA-1 of the decoded bytes, never by a board's file id (a hostile board can't alias another picture).
   Watch out: this shell had `HERDR_APP_HOME=~/.cache/hdt` set, so `scripts/dev-sync.sh` installed into the test home; use
   `env -u HERDR_APP_HOME sh scripts/dev-sync.sh` to install for the person. (t2r, who made `0e27966`, has stood down: one writer now.)
   The person's board pane was reopened on the final build at ~17:40; its pane id lives in `~/.local/state/herdr-core/default/docs.json`
   (`herdr-app ls` lists terminals only, not mod panes).
2. ~~PNG export~~ done (2026-11-08): ⌘⇧E writes `board.svg` + a 2× `board.png` (sips), cropped to the drawing on the board's
   page color; `herdr-app do herdr-draw.export`; `drawh export FILE [--svg] [--dark] [--out]`. Verified live via the command.
3. ~~Library~~ done (2026-11-08): sidebar "Library" (previews, click inserts, + saves the selection, ✕ removes, drop a
   `.excalidrawlib` to merge) and `drawh lib ls|add|insert|import|rm`. Verified live: `drawh lib add` showed up in the open
   pane's panel with previews, and `drawh lib insert` landed on the board with labels. Headless only: clicking a tile, the "+"
   button, ✕, and dropping a library (keys and clicks don't reach the test pane). Verified (probe): our `.excalidrawlib` imports
   into excalidraw.com's library, both items, the picture item with its file (its tile there is blank). Library items, copy and
   duplicate now take arrow labels along (they were left behind) and carry the file's label boxes.
   Also: arrows now bind to images and elbows route around them; paste gives copies fresh group ids.
   Small: library previews are cached with the theme colors of the moment; a theme change shows old colors until the item changes.
4. ~~Elbow fidelity~~ done (2026-11-08, third session): elbows write Excalidraw's `binding.fixedPoint` (fraction of the bound
   shape's unrotated box; 0.5 → 0.5001 like excalidraw.com). Without it excalidraw.com pinned elbow ends to shape centers and
   looped when a shape moved. `drawh` now bakes elbow routes on every save (core `settle` through node). **Verified in
   excalidraw.com** with a headless-Chromium probe (see "excalidraw.com probe" below): load and drag keep clean routes.
   We still pick sides automatically (we don't read fixedPoint back as a side lock). Rotated shapes: the elbow leaves the
   rotated box's bounding box, not its outline (same in the pane); excalidraw.com keeps it there and re-routes without loops. Cost: dragging a hub with 100 elbows
   is ~4.4 ms/frame headless (10: 0.5 ms), so no work needed.
   Found on the way, fixed: excalidraw.com paints labels from their stored x/y/width/height, which we never kept (drawh labels
   sat top-left, Mermaid labels had width 0 and were invisible). `fileScene()` (core/geometry.js) now writes the derived label
   box on every save (pane and drawh), with no new versions. drawh settles every bound arrow on save (ends on outlines, not
   centers; ~0.19 s per drawh call, node startup), and `drawh arrow --label` makes a bound arrow label. Verified live in the
   isolated Herdr (drawh move re-routes the open pane's elbow; labels ride their arrows).
   Left: excalidraw.com puts an arrow label at the route's middle *point* (the bend on a 3-point elbow); we put it halfway
   along the length. Our wrapped label `text` stays unwrapped (excalidraw.com re-wraps from `originalText`).

## excalidraw.com probe

`node scripts/excalidraw-probe.mjs BOARD OUT.png [ID]` drops a board onto excalidraw.com in headless Chromium (local only:
excalidraw.com keeps it in the page's localStorage), prints the arrows as it restored them, screenshots, and with an ID first
drags that element down 150 px. Use it for any "does it open right in excalidraw.com" question.
5. ~~Text measuring~~ done (2026-11-08, third session): `core/text.js` `textWidth(line, size, fontFamily)` serves all wrapping,
   label boxes and text sizes, from per-glyph tables for the pane's fonts (SF Pro as the pane spaces it, Chalkboard SE; mono
   0.6; wide chars an em), generated by `scripts/glyph-widths.mjs`. A test sentence matches the live pane within 0.5%
   (measured in the isolated window from a shot: zoom 1.2 × 2× display = 2.4 device px per scene px). drawh's save pass also
   grows shapes to fit their labels (the pane only did this when a person typed); in the pane, changing a label's font
   family now refits its shape too, and free text takes its new width on a font or size change. Verified live: sans, hand and mono labels
   wrap to their box and the boxes fit. Caveats: if Excalifont/Virgil is installed the pane's hand face changes and the hand
   table (Chalkboard SE) is off by a few %; a person's terminal mono font wider than 0.6 em would overflow slightly.
   PNG export used to draw hand and mono labels in plain sans (sips takes only the first font in a list; Excalifont isn't
   installed); raster exports now name one installed face per class. `drawh`'s save pass settles only what that run changed
   (plus arrows bound to it), so an excalidraw.com arrow aimed off-center isn't re-aimed by an unrelated write.
   `wrapLines` is guarded against zero/broken widths (an automated security review flagged a possible endless loop).
6. Small, open: excalidraw.com puts an arrow label at the route's middle point (on a 3-point elbow, the bend); we put it
   halfway along the length, so the label jumps once someone edits the arrow there. Free text written by drawh keeps
   Python's rough width (labels are redone by core; free text isn't).
7. Networking (deferred by the person): another `onOp` / `receive` pair; presence already renders from `editor.peers`.

## Rules the person set

- Tests for every feature; verify in the isolated Herdr; commit locally; **don't push**.
- Never drive the person's mouse or keyboard; key input only into the isolated window.
- Stop and write a note like this one past ~75% context.
