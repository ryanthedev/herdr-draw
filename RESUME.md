# Resume note: herdr-draw (2026-11-08)

For the next session picking this up. Read `CLAUDE.md` first (architecture, ports, dev loop, gotchas).

## Where it stands

- All work is committed locally on `main` and **not pushed** (no remote yet). Latest: `f49bbe1` images + boards over 1 MiB.
- `bun test`: 90 tests, all passing. Snapshots in `test/out/*.png`.
- Installed into `~/.config/herdr-app/mods/herdr-draw` (via `scripts/dev-sync.sh`); `drawh` is on PATH (`~/.local/bin/drawh` → the installed copy).

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

## Open issue outside this repo

The person's **main Herdr window** has an exhausted mod runtime (`mod pane: out of memory`, `Null"null"` for herdr-draw, herdr-md, toast). The herdr-md session confirmed it; the person restarts Herdr when back. Until then the main window runs old builds. **Do not quit or restart the main window.** After the restart, reopen the board: `drawh open ~/boards/sketch.excalidraw`.

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
   Also open: binding arrows to images (only shapes bind), and a board over 8 MiB can't be read (exec's output cap).
2. **PNG export.** No rasterizer in the mod: shell out to headless Chrome like `test/harness/raster.js`, or `sips` an SVG (check quality).
3. **Library / templates** (save a selection, insert it; Excalidraw `.excalidrawlib` format).
4. **Elbow fidelity**: write Excalidraw's `fixedPoint` bindings so elbows open right in excalidraw.com; measure routing cost when dragging a hub with many elbows.
5. **Text measuring**: wrapping uses an estimated glyph width (`core/text.js` `CHAR_W`); hand and mono fonts wrap a bit off.
6. Networking (deferred by the person): another `onOp` / `receive` pair; presence already renders from `editor.peers`.

## Rules the person set

- Tests for every feature; verify in the isolated Herdr; commit locally; **don't push**.
- Never drive the person's mouse or keyboard; key input only into the isolated window.
- Stop and write a note like this one past ~75% context.
