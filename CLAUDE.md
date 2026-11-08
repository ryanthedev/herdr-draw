# herdr-draw

A sketchy whiteboard in a Herdr pane, with layers, animation and an agent CLI.
Boards are `.excalidraw` files (they still open in excalidraw.com).

## Shape (hexagonal: one core, many adapters)

```
core/            pure JS, no imports from Herdr, the DOM, Node or the network
  model.js       element factory, layers, versions (Excalidraw format + customData)
  doc.js         the board in memory; Doc.apply(op) is the ONLY way it changes
  geometry.js    boxes, hit testing, arrow binding, resize mapping
  render.js      board → display list (paths + text, screen coords)
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

- `bun test` (27 tests). Snapshots land in `test/out/*.png` (headless Chromium from Playwright's cache).
- `scripts/dev-sync.sh` builds `build/herdr-draw` (adapter + core + svg + drawh) and installs a **copy** into `~/.config/herdr-app/mods/herdr-draw`.
- See the real window only with `herdr-app shot` (passive). **Never drive the person's mouse or keyboard** to test (theGrid input tools land in whatever app is focused).

## Gotchas

- Never keep an event's `cx` past its handler (stored in a closure, `.then()` on it, handed to a timer later): GPUI rejects it (see `Context` in `gpui-kit.d.ts`). Use the async `cx` from `cx.spawn`/timer callbacks. `test/harness/gpui-fake.js` throws `stale cx` when this happens.
- `appState.herdr` (layers, grid) has no version: if the pane changes layers and `drawh` writes within the 250 ms save window, the layer change can be lost (elements survive on the base layer).
- `pbcopy` gets the clipboard JSON as a shell argument; a huge selection could pass the argv limit.

- GPUI has no "mouse up outside": the adapter ends a drag on `on_hover(false)`, and the core ends a stale gesture on the next press.
- `"transparent"` is not a GPUI color: use `#00000000`.
- Coordinates: GPUI event positions are zoomed px; divide by `settings().zoom`. Paths and `left/top` use the same zoom-1 units.
- Text is drawn as divs above all paths (no text-in-path API), so text always paints over shapes.
- No rotation yet (`angle` stays 0).
- Writers other than the pane must bump `version` on every element they change (drawh does), or the pane may keep its copy.
