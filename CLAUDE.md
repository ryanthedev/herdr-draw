# herdr-draw

A sketchy whiteboard in a Herdr pane, with layers, animation and an agent CLI.
Boards are `.excalidraw` files (they still open in excalidraw.com).

## Shape (hexagonal: one core, many adapters)

```
core/            pure JS, no imports from Herdr, the DOM, Node or the network
  model.js       element factory, layers, versions (Excalidraw format + customData)
  doc.js         the board in memory; Doc.apply(op) is the ONLY way it changes
  geometry.js    boxes, hit testing, arrow binding, resize mapping
  render.js      board → display list (paths + text + images, screen coords)
  export.js      the drawing cropped to what's painted, any pixel ratio, on the board's page color
  library.js     .excalidrawlib read (v1, v2) / write (v2); Editor.insertElements is the one insert path (paste, library)
  anim.js        timeline presets / keyframes → per-element state at time t
  editor.js      tools, gestures, selection, undo, layers, align, clipboard, commands
adapters/herdr/  the Herdr mod: GPUI events → editor; display list → GPUI. store.js = file port
adapters/svg/    display list → SVG (tests, export)
cli/drawh        the agents' CLI (Python, edits the file; pane picks it up)
test/            bun test: core with synthetic input; the real Herdr adapter on a fake GPUI
```

Ports the core expects, so new adapters plug in without touching it:
- **Input**: `pointerDown/Move/Up(p, mods)`, `wheel`, `key(name, mods)`, `setText/commitText` — screen px, zoom-1.
- **Output**: `displayList(theme)`; `textBox()` for where to put a text field; `needsTick()/tick()` for animation frames.
- **Sync**: `new Editor({ onOp })` emits every change as `{ elements, appState?, transient? }`; `editor.receive(op)` takes changes from anywhere.
  Elements carry Excalidraw's `version`/`versionNonce`; higher version wins, so ops can be replayed in any order on any replica.
  The file store and `drawh` already use this. A network transport is another `onOp`/`receive` pair: no core change.
- **Presence**: `editor.peers` (cursor, name, color) already renders; a transport only has to fill it.

Herdr-draw data lives where Excalidraw keeps foreign data: `customData.{layer,z,anim}` per element, `appState.herdr.{layers,grid,snap}` per board.

## Dev loop

- `bun test` (133 tests). `drawh mermaid` runs core/mermaid.js through node (or bun), so agents and the pane lay out alike. Snapshots land in `test/out/*.png` (headless Chromium from Playwright's cache).
- `scripts/dev-sync.sh` builds `build/herdr-draw` (adapter + core + svg + drawh) and installs a **copy** into `~/.config/herdr-app/mods/herdr-draw`.
- `scripts/install.sh` installs **HEAD** into the person's Herdr (ignores `HERDR_APP_HOME`): run it after commits the person
  should test. If `.git/hooks/post-commit` exists (`scripts/install-hook.sh`), every commit to `main` installs itself. ⌘⇧B opens a scratch board. Their notes: `FEEDBACK.md`.
- See the real window only with `herdr-app shot` (passive). **Never drive the person's mouse or keyboard** to test (theGrid input tools land in whatever app is focused).

## Testing in a real Herdr window (never the person's)

Start a separate window on its own home (keep the path short: the socket path has a length limit):

```sh
env -u CLAUDECODE -u CLAUDE_PID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u HC_TERMINAL_ID -u HC_SCOPE \
  open -g -n -a Herdr --env HERDR_APP_HOME=$HOME/.cache/hdt
```

**Never launch a Herdr window (test or main) from a Claude shell without that `env -u`.** The
window inherits the shell's environment and hands it to every terminal it starts. A Claude
started there inherits `CLAUDE_CODE_CHILD_SESSION=1`, prints "Transcript saving is off", and can't
be resumed (seen 2026-11-08 on t4t and t4v). Give that home `shared.json`
`{"layout":"drawtest","frame.welcomed":"finished"}` and a `layouts/drawtest.json` whose root is a
block with `{"mod":"herdr-draw","props":{"file":...}}`. Show the board as a layout block, never
`tab.new`/`pane.split`: spaces and tabs are shared with the person's window through herdr-core.
Drive it with `HERDR_APP_HOME=... herdr-app do herdr-draw.<fit|play|write>`, `herdr-app shot`, and key input
sent only to that window's id; quit it by its pid when done.

## Gotchas

- Herdr's Textarea (verified live): Enter and Shift+Enter insert a line break **and** fire `submit`;
  ⌘Enter fires `submit` with `secondary`. So only a secondary submit finishes text (Excalidraw keys).
- A rebuilt mod can fail to reload in place in an open pane with `Null"null"` in `herdr-app status`
  while fresh loads and reloads in a test window work (herdr-md hit the same message). The old build keeps
  running in that pane; reopening the pane loads the new one.

- Never keep an event's `cx` past its handler (stored in a closure, `.then()` on it, handed to a timer later): GPUI rejects it (see `Context` in `gpui-kit.d.ts`). Use the async `cx` from `cx.spawn`/timer callbacks. `test/harness/gpui-fake.js` throws `stale cx` when this happens.
- `appState.herdr` (layers, grid) has no version: if the pane changes layers and `drawh` writes within the 250 ms save window, the layer change can be lost (elements survive on the base layer).
- `pbcopy` gets the clipboard JSON as a shell argument; a huge selection could pass the argv limit.

- GPUI has no "mouse up outside": the adapter ends a drag on `on_hover(false)`, and the core ends a stale gesture on the next press.
- `"transparent"` is not a GPUI color: use `#00000000`.
- Coordinates: GPUI event positions are zoomed px; divide by `settings().zoom`. Paths and `left/top` use the same zoom-1 units.
- Text is drawn as divs above all paths (no text-in-path API), so text always paints over shapes.
- Text widths come from glyph tables in `core/text.js` (SF Pro as the pane spaces it, Chalkboard SE, mono 0.6), made by
  `scripts/glyph-widths.mjs`. Never use a flat chars × factor estimate elsewhere: call `textWidth`/`lineWidth`.
- Rotation: shapes and text keep `angle`; lines, arrows and pen strokes bake it into their points. Herdr can't rotate text, so text stays upright in the pane (SVG export rotates it).
- Elbow arrows (`elbowed: true`) are routed from their ends every revision (cached per arrow per `doc.rev`) and baked into
  `points` by `settle`, with Excalidraw's `binding.fixedPoint` (without it excalidraw.com pins elbow ends to shape centers).
  We choose sides ourselves and never read `fixedPoint` back.
- excalidraw.com draws from stored geometry: labels from their own x/y/width/height, arrows from their points. We derive
  both, so `fileScene()` (core/geometry.js) writes the derived label boxes on every save, and drawh runs core `settle` +
  `fileScene` through node on every save, re-routing/growing only what that run changed plus arrows bound to it (so drawh needs node or bun for nearly every write, ~0.2 s). An older board's
  first save from the pane rewrites its label boxes with no version bumps: expected, not a dirty pane. Check with `node scripts/excalidraw-probe.mjs BOARD OUT.png [ID]` (headless).
- Images: `image` elements point at `files[fileId]` (base64 data URLs, ids are SHA-1 of the bytes); ops carry an add-only `files` map.
  `image()` loads only paths under `appHome()` (`$HERDR_APP_HOME` in a test window, not `home()`), so the pane decodes blobs into
  `<appHome>/.cache/herdr-draw/img/` (base64 via a temp file, never argv). Like text, images can't rotate in the pane; they paint in
  order between path batches, text still on top.
- Herdr's `readTextFile` rejects files over **1 MiB** (verified live: a board with two photos wouldn't open, and the watch loop died).
  All board I/O goes through `adapters/herdr/io.js`: big files are read with `cat` (exec caps output at 8 MiB); past 8 MiB, perl
  splits them into <1 MiB parts on character boundaries (the runtime has no TextDecoder) read with readTextFile (limit 64 MiB).
  Writes go as <1 MiB parts joined by `cat` + `mv`. The big write's stale check is read-then-rename, not atomic.
- Export (⌘⇧E, `herdr-app do herdr-draw.export`, `drawh export`): SVG from `core/export.js`, PNG = that SVG at 2× through
  macOS `sips` (verified live; QuickLook crops to a square). Raster exports pass `svgImages: false` to `toSvg`: only pictures whose
  bytes match their declared PNG/JPEG/GIF/WebP type go to sips, so a board's SVG can't make it fetch files or URLs.
  Give an SVG background explicit width/height, never `100%`: sips sized it from the pixel size and left a 2× PNG mostly black.
  sips uses only the **first** family of a `font-family` list (sans if it's missing), so raster SVGs name one face per class
  (`RASTER_FACES`, or the pane's own `face()`); plain SVG exports keep the full fallback lists.
- Library file: `<appHome>/herdr-draw/library.excalidrawlib` (pane and `drawh lib`; `HERDR_APP_HOME` picks the test home's).
  Items carry their pictures' `files` (a herdr extension: excalidraw.com shows library pictures as placeholders). Sidebar
  previews draw paths only, no text or pictures.
- Writers other than the pane must bump `version` on every element they change (drawh does), or the pane may keep its copy.
