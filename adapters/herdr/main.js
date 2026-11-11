// herdr-draw — the Herdr adapter. Thin on purpose: it turns GPUI events into
// editor calls and the editor's display list into GPUI elements. All behavior
// lives in ./core (tested headless with `bun test`).
//
// Open: pane.split {mod: "herdr-draw", props: {file}}. Agents use `drawh`.

import { View, div, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, exec, theme, settings, home, appHome, nextCommand, panes, focused, readTextFile, writeTextFile, fonts, machines, spaces, openOverlay, closeOverlay } from "herdr";
import { Editor, TOOLS, STROKES, FILLS, WIDTHS, STYLES } from "./core/editor.js";
import { withAlpha, planBatches } from "./core/render.js";
import { PRESET_NAMES } from "./core/anim.js";
import { exportScene, boardTheme, paintedBox } from "./core/export.js";
import { parseLibrary, mergeLibrary } from "./core/library.js";
import { Doc } from "./core/doc.js";
import { paintScene } from "./core/render.js";
import { LibraryStore } from "./library-store.js";
import { FONT_FAMILY } from "./core/style.js";
import { isShape, isLabel, layerOf } from "./core/model.js";
import { toSvg, RASTER_FACES } from "./svg.js";
import { FileStore } from "./store.js";
import { readText, writeText } from "./io.js";
import { SHORTCUTS, takenKeys, fitKeys } from "./core/shortcuts.js";
import { demoScene } from "./core/demo.js";
import { rankBoards, newBoardPath, parseRecent, pushRecent, parseListing, boardName, folderOf, tilde, boardRef, parseRef } from "./core/boards.js";
import { emptyScene } from "./core/model.js";
import { panelLayout, panelSections, dragWidth, titleOf, WIDTH } from "./core/panel.js";
import { panelState, loadPanel, changePanel, savePanel, panelChanged } from "./panel-store.js";
import { colorRow, pickerModel, parseColorInput, inkOn } from "./core/color.js";
import { addBoard, removeBoard, useBoard, activeBoard, popoutId, setPopout, listen, ping } from "./panes.js";

const MOD = "herdr-draw";
// Boards: new ones go in ~/boards; the recent list is shared by every board pane.
const BOARDS_DIR = () => `${home()}/boards`;
const RECENT = () => `${appHome()}/herdr-draw/recent.json`;
const PICK_ROWS = 12;
const Z = () => Number(settings().zoom) || 1;
const CACHE = () => `${home()}/.cache/herdr-draw`;
const ALIGN = [["left", "⇤", "⌥A"], ["hcenter", "↔", "⌥H"], ["right", "⇥", "⌥D"], ["top", "⤒", "⌥W"], ["vcenter", "↕", "⌥V"], ["bottom", "⤓", "⌥S"]];
const BADGES_MIN_W = 640;   // narrower than this, the toolbar shows icons only (keys stay in tooltips and ?)
const isHelpKey = e => e.key === "?" || e.key_char === "?" || (e.key === "/" && !!e.modifiers?.shift && !e.modifiers?.platform);
const CLEAR = "#00000000";
const CURSORS = { crosshair: "cursor_crosshair", pointer: "cursor_pointer", move: "cursor_move", grab: "cursor_grab", grabbing: "cursor_grabbing",
  text: "cursor_text", "ns-resize": "cursor_ns_resize", "ew-resize": "cursor_ew_resize", "nwse-resize": "cursor_nwse_resize", "nesw-resize": "cursor_nesw_resize" };
const cursorStyle = (el, name) => (CURSORS[name] && typeof el[CURSORS[name]] === "function" ? el[CURSORS[name]]() : el);
// image() loads only paths under the app home (~/.config/herdr-app or $HERDR_APP_HOME), so
// board images are decoded into a hidden cache there: outside the mod folder (no hot reload,
// and a dev sync's rsync --delete doesn't wipe it).
const IMG_REL = ".cache/herdr-draw/img";
const IMG_DIR = () => `${appHome()}/${IMG_REL}`;
// Rotated text: GPUI can't turn text, so sips draws each rotated text item as a transparent PNG here,
// named by a hash of its SVG (GPUI caches images by path, so a changed picture gets a new name).
const TXT_REL = ".cache/herdr-draw/txt";
const TXT_DIR = () => `${appHome()}/${TXT_REL}`;
const fnv = str => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0") + str.length.toString(16); };
const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|heic|heif|tiff?|bmp)$/i;

// One file → { id, mimeType, width, height, dataURL }. Formats GPUI or Excalidraw may not
// take (HEIC, TIFF…) become PNG, and anything over 2 MB becomes a JPEG at most 2000 px, so the
// base64 fits exec's 8 MiB output. The id is the SHA-1 of the bytes, as Excalidraw's are.
// The file is copied into the image cache under its final name, so it never needs decoding.
const IMPORT_SH = `set -e
src="$1"; dir="$2"; mkdir -p "$dir"
ext=$(printf %s "\${src##*.}" | tr A-Z a-z)
case "$ext" in png) m=image/png;; jpg|jpeg) m=image/jpeg;; gif) m=image/gif;; webp) m=image/webp;; svg) m=image/svg+xml;; *) m=;; esac
size=$(stat -f %z "$src")
work="$src"
if [ "$m" != image/svg+xml ] && { [ -z "$m" ] || [ "$size" -gt 2000000 ]; }; then
  if [ "$size" -gt 2000000 ]; then work="$dir/import-$$.jpg"; m=image/jpeg; sips -s format jpeg -s formatOptions 85 -Z 2000 "$src" --out "$work" >/dev/null
  else work="$dir/import-$$.png"; m=image/png; sips -s format png "$src" --out "$work" >/dev/null; fi
fi
id=$(shasum -a 1 < "$work" | cut -c1-40)
case "$m" in image/png) e=png;; image/jpeg) e=jpg;; image/gif) e=gif;; image/webp) e=webp;; *) e=svg;; esac
cp "$work" "$dir/$id.$e"
dims=$(sips -g pixelWidth -g pixelHeight "$work" 2>/dev/null | awk '/pixel(Width|Height)/{printf "%s ", $2}')
printf '%s\n%s\n%s\n' "$id" "$m" "$dims"
base64 < "$work" | tr -d '\n'
if [ "$work" != "$src" ]; then rm -f "$work"; fi`;

// The clipboard's image (a screenshot, a copied picture) as a PNG file; prints its path.
const CLIP_SH = `out="$1"; mkdir -p "$(dirname "$out")"; rm -f "$out"
osascript -e 'on run argv' -e 'set f to open for access (POSIX file (item 1 of argv)) with write permission' -e 'set eof f to 0' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f' -e 'end run' "$out" >/dev/null 2>&1
[ -s "$out" ] && printf %s "$out"`;

// A display list → native path layers in paint order (consecutive paths with one style become
// one path), images between them, and the text items (drawn as divs on top).
// The display list as drawing calls: paths of one style merged into one call wherever that can't
// change what shows on top (core planBatches). Each call costs Herdr a paint_path; a big board fitted
// to a pane made ~900 of them per frame, enough to hit the runtime's time limit.
const styleKey = it => { const color = withAlpha(it.fill ?? it.stroke, it.opacity ?? 1); return it.fill ? `f|${color}` : `s|${color}|${it.width}|${it.dash?.join(",") ?? ""}`; };
function batchPaths(items) {
  const plan = planBatches(items, styleKey), layers = [];
  for (const l of plan.layers) {
    if (l.img) { layers.push({ img: l.img, n: 1 }); continue; }
    const first = l.items[0], fill = !!first.fill;
    let b = fill ? PathBuilder.fill() : PathBuilder.stroke(first.width);
    if (first.dash) b = b.dash_array(first.dash);
    for (const it of l.items) {
      let started = false;
      for (const c of it.cmds) {
        if (c[0] === "M" && fill && started) b.close();   // each filled shape closes before the next starts
        started = true;
        if (c[0] === "M") b.move_to(c[1], c[2]);
        else if (c[0] === "L") b.line_to(c[1], c[2]);
        else if (c[0] === "Q") b.curve_to(c[1], c[2], c[3], c[4]);
      }
      if (fill) b.close();
    }
    layers.push({ key: l.key, color: withAlpha(first.fill ?? first.stroke, first.opacity ?? 1), b, n: l.items.length });
  }
  return { layers, texts: plan.texts };
}

// A machine this Herdr reaches by that name (a space's `machine`), or null: this computer. A board
// pane's `machine` prop names where its file lives; the same pane drawn by that machine's own Herdr
// window doesn't list itself, so there the file is local.
const remoteOn = m => (m && (machines?.() ?? []).some(x => x.name === m) ? m : null);
// The machine of the space with the keyboard (null: this computer).
const focusedMachine = () => { const f = focused?.(); return f ? ((spaces?.() ?? []).find(s => s.id === f.space)?.machine ?? null) : null; };

// The machine that has `file` when this one doesn't: a board pane in a space on another machine, made
// there (drawh open names only a path), is drawn by this Herdr too. null: here, or nowhere we can reach.
async function locateBoard(file) {
  const here = await exec("test", ["-e", file]).catch(() => null);
  if (!here || here.code === 0) return null;
  for (const m of machines?.() ?? []) {
    if (!m.name || m.layout === "unavailable") continue;
    const r = await exec("test", ["-f", file], { on: m.name }).catch(() => null);
    if (r?.code === 0) return m.name;
  }
  return null;
}

// Write a small file in `dir` atomically (temp + mv), fire and forget.
function cx_free_write(dir, name, text) {
  exec("sh", ["-c", 'mkdir -p "$1" && printf %s "$3" > "$1/.$2.$$" && mv -f "$1/.$2.$$" "$1/$2"', "write-small", dir, name, text]);
}

export default class Draw extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.panel) return this.initPanel(p, cx);
    this.propFile = p.file ? String(p.file).replace(/^~(?=\/)/, home()) : null;
    this.propMachine = typeof p.machine === "string" && p.machine ? p.machine : null;   // where the file lives (null: here)
    // A pane remembers the board it was switched to (⌘O), as long as it was opened on the same props.
    let mem = null; try { mem = JSON.parse(localStorage.getItem("board") ?? "null"); } catch { mem = null; }
    const same = mem && mem.props === this.propFile && (mem.propMachine ?? null) === this.propMachine && typeof mem.file === "string";
    this.file = same ? mem.file : this.propFile;
    this.machine = remoteOn(same ? mem.machine ?? null : this.propMachine);
    this.homes = {};   // other machines' home folders, as the picker learns them
    // Ops only mark the board dirty; after(cx) schedules the save with the live event's cx
    // (a cx kept past its call is rejected by GPUI).
    this.ed = this.newEditor();
    this.error = null;
    this.picker = null;     // the board picker: { query, rows, sel, top } while open
    this.pickInput = InputState.new({ value: "", placeholder: "Find a board, or type a new name" });
    this.pickInput.on("change", (_e, cx) => { if (this.picker && this.picker.query !== this.pickInput.value()) { this.picker.query = this.pickInput.value(); this.rankPicker(); cx.notify(); } });
    this.pickInput.on("submit", (e, cx) => { if (e?.secondary) this.pickCreate(cx); else this.pickOpen(cx); });
    this.boardList = null; this.recent = []; this.pv = new Map();   // listing, recent boards, previews by path
    this.textOpen = false; this.renaming = null;
    this.taken = new Set();   // ⌘ keys the person's Herdr takes first (keys.json): shown as ⌃ here
    this.loadKeys(cx);
    this.flash = null; this.sidebar = p.sidebar ?? true; this.selKey = "";
    this.help = false;      // the ? overlay
    this.board = null;      // while the demo plays: the person's own editor, kept aside (the demo is never saved)
    this.tick = null; this.size = { w: 900, h: 600 }; this.measured = false;   // a default size so panels render before layout
    this.handle = cx.focus_handle();
    this.rtext = new Map();  // rotated text: element id → { key, path, want: { key, svg }, busy }
    exec("sh", ["-c", 'rm -rf "$1" && mkdir -p "$1"', "txt-reset", TXT_DIR()]);   // regenerated on demand: no stale pile
    this.imgs = new Map();   // file id → cache path (relative to the app home) once decoded; "pending" / "failed"
    // Multi-line: a submit with ⌘ (or any submit, if Enter submits) commits; Escape or a click outside commits too.
    this.input = TextareaState.new({ value: "", placeholder: "Type… (Esc or ⌘⏎ to finish)", rows: 1 });
    this.input.set_auto_grow?.(1, 10);
    this.input.on("change", (_e, cx) => { this.ed.setText(this.input.value()); this.after(cx); });
    // Herdr's textarea, seen live in a test window: Enter and Shift+Enter insert a line break AND
    // fire "submit"; ⌘Enter fires submit with `secondary`. Excalidraw's keys are Enter = new line,
    // ⌘Enter / Escape = finish, so only a secondary submit finishes; a plain one keeps its line break.
    this.input.on("submit", (e, cx) => {
      if (e?.secondary) this.ed.commitText();
      else this.ed.setText(this.input.value());
      this.after(cx);
    });
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; if (this.ed.text) { this.ed.commitText(); this.after(cx); } });
    this.panelInputs();
    this.lib = new LibraryStore({ onChange: () => { this.previews.clear(); }, onError: m => { this.flash = m; } });
    cx.spawn(async acx => { await this.lib.start(acx); });
    // The side panel's settings are every pane's (panel-store.js): redraw when any pane changes them.
    cx.spawn(async acx => { await loadPanel(); acx.notify(); for (;;) { await panelChanged(); acx.notify(); } });
    if (this.file) this.startStore(cx);
    else cx.timer.after(30, cx => { this.openPicker(cx); cx.notify(); });   // no board yet (⌘⇧B): pick one
    // The popped-out panel (panes.js) drives the board used last; its changes land here to be saved.
    addBoard(this);
    this.changes = listen();
    cx.spawn(async acx => { for (;;) { const what = await this.changes.next(); if (what === "panel" && activeBoard() === this) this.after(acx); else if (what === "popout") acx.notify(); } });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "fit") this.ed.fit();
        else if (c === "play") this.ed.playToggle();
        else if (c === "export") { if (this.file) await this.exportBoard(); }
        else if (c === "write") this.ed.beginText(null, this.ed.toWorld({ x: this.size.w / 3, y: this.size.h / 3 }));   // start typing (no mouse needed)
        else if (c === "help") { this.help = !this.help; if (this.help) this.loadKeys(cx); }
        else if (c === "demo") { if (this.board) this.endDemo(); else this.startDemo(); }
        else if (c === "perf") { this.writePerf(); continue; }
        else if (c === "open") { if (this.picker) this.closePicker(cx); else this.openPicker(cx); }
        // Commands that act once, on the board used last (every board pane may get them).
        else if (c === "popout") { if (activeBoard() === this) this.togglePopout(); continue; }
        else if (c === "colors") {   // the Stroke picker, in view: Properties unfolded, or its tab shown
          if (activeBoard() !== this) continue;
          this.sidebar = true; this.customize = false;
          changePanel(panelState().mode === "tabs" ? { type: "tab", id: "properties" } : { type: "fold", id: "properties", folded: false });
          if (this.colorPick !== "stroke") this.toggleColorPick("stroke");
        }
        else if (c === "import") { if (activeBoard() !== this) continue; await this.importQueued(); }
        else if (c === "save") { if (this.store) await this.store.flush(cx); continue; }
        else if (c === "focus") { cx.timer.after(60, () => { if (panes().find(q => q.focused)?.mod === MOD) this.handle.focus(); }); continue; }
        this.after(cx);
      }
    });
  }

  // The side panel's own fields and inputs (a board pane's, and the popped-out panel's).
  panelInputs() {
    this.layerInput = InputState.new({ value: "", placeholder: "Layer name" });
    this.layerInput.on("submit", (_e, cx) => { if (this.renaming) this.ed.updateLayer(this.renaming, { name: this.layerInput.value() || "Layer" }); this.renaming = null; this.handle.focus(); this.after(cx); });
    // The color picker under the Stroke or Fill row: which one is open (this pane only), its hex
    // field and the field's last message. While the field has the keyboard, board keys stay off
    // (hex letters are shortcuts: C cycles strokes, B fills).
    this.colorPick = null; this.hexMsg = null; this.hexFocused = false;
    this.hexInput = InputState.new({ value: "", placeholder: "#rrggbb" });
    this.hexInput.on("focus", () => { this.hexFocused = true; });
    this.hexInput.on("blur", () => { this.hexFocused = false; });
    this.hexInput.on("submit", (_e, cx) => {
      const r = parseColorInput(this.hexInput.value());
      if (r.error) { this.hexMsg = r.error; return cx.notify(); }
      this.applyColor(this.colorPick, r.color);
      this.hexFocused = false; this.handle.focus(); this.after(cx);
    });
    this.sideW = 0;           // the panel's width as last drawn (0: hidden)
    this.panelDrag = null;    // dragging the panel's edge: { x, w }
    this.secDrag = null;      // dragging a section title: { id, moved }
    this.customize = false;   // the panel shows its own settings
    this.previews = new Map();   // library item id → its preview's path layers
  }

  // Herdr closes this pane (or quits): no more checks on another machine's board. The panel window
  // closing (its ✕, a layout switch) docks the panel again in every board pane.
  async close() {
    this.changes?.stop();
    if (this.panelOnly) { if (popoutId() === this.overlay) setPopout(null); return; }
    this.store?.stop(); removeBoard(this);
  }

  loadKeys(cx) {
    cx.spawn(async cx => { try { this.taken = takenKeys(await readTextFile(`${appHome()}/keys.json`)); cx.notify(); } catch {} });
  }
  // A key label as it works in this Herdr: ⌘X becomes ⌃X when keys.json gives ⌘X to something else.
  kk(label) { return typeof label === "string" ? fitKeys(label, this.taken) : label; }

  newEditor() { const ed = new Editor({ onOp: op => { if (!op.transient) this.dirty = true; } }); ed.setSize(this.size?.w ?? 900, this.size?.h ?? 600); return ed; }

  startStore(cx) {
    const store = this.store = new FileStore(this.file, this.ed, { on: this.machine,
      locate: this.machine ? null : file => locateBoard(file),
      onLocated: m => { if (this.store !== store) return; this.machine = m; this.remember(boardRef(this.file, m)); },
      onError: m => { if (this.store === store) this.error = m; },
      onExternal: n => { if (this.store === store) { this.error = null; this.flash = `${n} change${n === 1 ? "" : "s"} from the file`; } },
    });
    cx.spawn(async acx => { await store.start(acx); if (this.store !== store) return; this.fitted = false; this.maybeFit(); acx.notify(); });
    this.remember(boardRef(this.file, this.machine));
  }

  // This pane moves to another board: the current one is saved first, then a fresh editor and store.
  // `ref`: a path here, or "machine:/path" (boardRef) for a board on another machine.
  async switchBoard(ref, cx) {
    const { path: file, machine } = parseRef(ref), on = remoteOn(machine);
    if (file === this.file && on === this.machine && this.store) return;
    if (this.board) this.endDemo();
    if (this.ed.text) this.ed.commitText();
    if (this.store) { if (this.dirty) { this.dirty = false; } await this.store.flush(cx); this.store.stop(); }
    this.file = file; this.machine = on; this.error = null; this.flash = null; this.ed = this.newEditor(); this.selKey = "";
    try { localStorage.setItem("board", JSON.stringify({ props: this.propFile, propMachine: this.propMachine, file, machine: on })); } catch {}
    this.startStore(cx);
    cx.notify();
  }

  // Newest first in recent.json, shared by every board pane.
  remember(file) {
    this.recent = pushRecent(this.recent, file);
    const dir = `${appHome()}/herdr-draw`;
    cx_free_write(dir, "recent.json", JSON.stringify(this.recent));
  }

  // ── board picker (⌘O, ⌘⇧B, or the board's name in the toolbar) ──────────

  openPicker(cx) {
    if (this.picker) return;
    if (this.ed.text) this.ed.commitText();
    this.help = false;
    // Boards on the machine of the space you're in (a space on another machine lists that machine's).
    this.picker = { query: "", rows: [], sel: 0, top: 0, on: remoteOn(focusedMachine()) };
    this.pickInput.set_value("");
    this.rankPicker();
    this.pickInput.focus();
    cx.timer.after(30, () => { if (this.picker) this.pickInput.focus(); });   // not drawn yet: again after the frame
    cx.spawn(async cx => {
      this.recent = parseRecent(await readText(RECENT()).catch(() => null));
      this.boardList = await this.listBoards(this.picker?.on ?? null);
      if (this.picker) { this.rankPicker(true); cx.notify(); }
    });
  }
  closePicker(cx) { this.picker = null; this.handle.focus(); cx?.notify?.(); }

  // *.excalidraw files where boards live: ~/boards, this board's folder, the space's folder, the scratch board's.
  // `on`: list that machine's instead (its ~/boards, the space's folder, this board's if it's there).
  async listBoards(on = null) {
    const f = focused?.() ?? null;
    let dirs;
    if (on) {
      const h = await this.homeOf(on);
      dirs = [...new Set([h && `${h}/boards`, this.machine === on && this.file && folderOf(this.file), f?.cwd].filter(Boolean))];
    } else dirs = [...new Set([BOARDS_DIR(), !this.machine && this.file && folderOf(this.file), f?.cwd, `${appHome()}/herdr-draw`].filter(Boolean))];
    // find itself, no shell: each folder on its own (a missing one just lists nothing).
    let out = "";
    for (const d of dirs) {
      const r = await exec("find", [d, "-maxdepth", "4", "(", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", ".cache", "-o", "-name", "Library", "-o", "-name", ".Trash", ")", "-prune",
        "-o", "-type", "f", "(", "-iname", "*.excalidraw", "-o", "-iname", "*.excalidraw.json", ")", "-exec", "stat", "-f", "%m %N", "{}", "+"], on ? { on } : undefined).catch(() => null);
      out += (r?.stdout ?? "") + "\n";
      if (out.length > 400000) break;   // enough boards for a picker
    }
    const seen = new Set();
    return parseListing(out).map(b => ({ ...b, path: boardRef(b.path, on) })).filter(b => !seen.has(b.path) && seen.add(b.path));
  }
  // Another machine's home folder (asked once).
  async homeOf(on) {
    if (this.homes[on]) return this.homes[on];
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
    const h = r?.code === 0 && r.stdout.startsWith("/") ? r.stdout.trim() : null;
    if (h) this.homes[on] = h;
    return h;
  }

  rankPicker(keep = false) {
    const p = this.picker; if (!p) return;
    const was = p.rows[p.sel]?.path;
    p.rows = rankBoards(p.query, this.boardList ?? [], this.recent, { home: home(), homes: this.homes, current: this.file && boardRef(this.file, this.machine) });
    const q = p.query.trim();
    if (q && !p.rows.some(r => r.name.toLowerCase() === q.toLowerCase())) p.rows.push({ create: true, name: q, folder: p.on ? `${p.on}: ~/boards` : tilde(BOARDS_DIR(), home()) });
    const at = keep && was ? p.rows.findIndex(r => r.path === was) : -1;
    this.pickSelect(at >= 0 ? at : 0);
  }
  pickSelect(i) {
    const p = this.picker; if (!p) return;
    p.sel = Math.max(0, Math.min(p.rows.length - 1, i));
    if (p.sel < p.top) p.top = p.sel; else if (p.sel >= p.top + PICK_ROWS) p.top = p.sel - PICK_ROWS + 1;
  }

  pickOpen(cx) {
    const row = this.picker?.rows[this.picker.sel];
    if (!row) return;
    if (row.create) return this.pickCreate(cx);
    this.closePicker(cx);
    cx.spawn(async cx => { await this.switchBoard(row.path, cx); this.after(cx); });
  }
  // A new board named as typed, in ~/boards (never over an existing file).
  pickCreate(cx) {
    const q = this.picker?.query.trim(); if (!q) return;
    const on = this.picker.on ?? null, dir = on ? (this.homes[on] && `${this.homes[on]}/boards`) : BOARDS_DIR();
    if (!dir) { this.error = `Can't reach ${on} to make a board there`; return cx.notify(); }
    const taken = new Set((this.boardList ?? []).map(b => parseRef(b.path)).filter(r => r.machine === on).map(r => r.path));
    const path = newBoardPath(dir, q, taken), shown = on ? `${on}: ${tilde(path, this.homes[on])}` : tilde(path, home());
    this.closePicker(cx);
    cx.spawn(async cx => {
      await exec("mkdir", ["-p", folderOf(path)], on ? { on } : undefined);
      try { await writeText(path, JSON.stringify(emptyScene(), null, 2), null, { on }); }
      catch (e) { this.error = `Can't make ${shown}: ${e?.message ?? e}`; cx.notify(); return; }
      await this.switchBoard(boardRef(path, on), cx);
      this.flash = `new board: ${shown}`;
      this.after(cx);
    });
  }

  pickKeys(e, cx) {
    const k = e.key, m = e.modifiers ?? {}, c = !!m.control, done = () => cx.stop_propagation();
    if (k === "escape") { this.closePicker(cx); return done(); }
    if (k === "enter") { if (m.platform || c) this.pickCreate(cx); else this.pickOpen(cx); return done(); }
    if (k === "down" || (c && (k === "n" || k === "j"))) { this.pickSelect(this.picker.sel + 1); cx.notify(); return done(); }
    if (k === "up" || (c && (k === "p" || k === "k"))) { this.pickSelect(this.picker.sel - 1); cx.notify(); return done(); }
    if (k === "pagedown" || k === "pageup") { this.pickSelect(this.picker.sel + (k === "pagedown" ? 1 : -1) * (PICK_ROWS - 1)); cx.notify(); return done(); }
    if ((m.platform || c) && k === "o") { this.closePicker(cx); return done(); }
    if (!m.platform && !c) this.pickInput.focus();   // typing goes to the search, even after a click elsewhere
  }

  // A small drawing of a board (paths only), read once per file and size.
  boardPreview(path, w, h, t) {
    const key = `${path}|${w}|${h}`;
    let pv = this.pv.get(key);
    if (!pv) this.pv.set(key, pv = { layers: null, want: { path, w, h } });   // read after this frame (loadPreviews)
    const body = div().relative().w(w).h(h).overflow_hidden().rounded(6).border(1).border_color(t.border).bg(withAlpha(this.palette().fg, 0.03));
    if (!pv.layers) return body.flex().items_center().justify_center().child(div().text_size(11).text_color(t.dim).child("…"));
    if (!pv.layers.length) return body.flex().items_center().justify_center().child(div().text_size(11).text_color(t.dim).child("empty board"));
    return body.children(pv.layers.map(l => div().absolute().top(0).left(0).size_full().child(window.paint_path(l.b.build(), l.color))));
  }

  // Previews the picker asked for: read the board, draw its paths small, then redraw the pane.
  async loadPreviews(cx) {
    for (const pv of this.pv.values()) {
      if (!pv.want) continue;
      const { path, w, h } = pv.want; pv.want = null;
      await readText(path).then(text => {
        try {
          const s = JSON.parse(text ?? "{}"), doc = new Doc({ elements: s.elements ?? [], files: {} }), pal = this.palette();
          const box = paintedBox(doc, pal);
          if (!box) { pv.layers = []; return; }
          const pad = 8, k = Math.min(1, (w - pad * 2) / Math.max(1, box.w), (h - pad * 2) / Math.max(1, box.h));
          const ox = (w - box.w * k) / 2, oy = (h - box.h * k) / 2;
          pv.layers = batchPaths(paintScene(doc, { x: ox / k - box.x, y: oy / k - box.y, scale: k }, pal).filter(i => i.t === "path")).layers.filter(l => l.n && !l.img);
        } catch { pv.layers = []; }
      }).catch(() => { pv.layers = []; });
      cx.notify();
    }
  }

  pickerOverlay(t) {
    const p = this.picker, rows = p.rows.slice(p.top, p.top + PICK_ROWS), wide = this.size.w >= 720;
    const row = (r, i) => {
      const idx = p.top + i, sel = idx === p.sel;
      return h_flex().id(`pick-${idx}`).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(sel ? withAlpha(t.accent, 0.18) : CLEAR).hover(s => s.bg(sel ? withAlpha(t.accent, 0.18) : t.hover))
        .on_click((_e, cx) => { this.pickSelect(idx); this.pickOpen(cx); })
        .child(div().w(10).flex_shrink_0().text_size(9).text_color(r.create ? t.accent : r.recent ? t.accent : t.border).child(r.create ? "+" : r.recent ? "●" : ""))
        .child(div().flex_shrink_0().text_size(13).text_color(t.foreground).when(sel, e => e.font_semibold()).child(r.create ? `New board “${r.name}”` : r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.create ? `in ${r.folder}` : r.folder))
        .when(!!r.current, e => e.child(div().text_size(10).text_color(t.dim).child("open here")));
    };
    const cur = p.rows[p.sel];
    const list = v_flex().flex_1().min_w(0).gap(1)
      .children(rows.map(row))
      .when(!p.rows.length, e => e.child(div().px(10).py(8).text_size(12).text_color(t.dim).child(this.boardList ? "No boards yet: type a name to make one" : "Looking for boards…")));
    return div().id("picker").absolute().top(0).left(0).size_full().bg(withAlpha(t.background, 0.82)).flex().justify_center().items_start().pt(40)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.closePicker(cx); })
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(v_flex().id("picker-card").w(wide ? 760 : Math.max(280, this.size.w - 32)).max_h_full().gap(10).p(14).rounded(10).border(1).border_color(t.border).bg(t.surface ?? t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(15).font_semibold().child("Boards"))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(this.kk("↑↓ move · Enter open · ⌘Enter new · Esc close"))))
        .child(Input.new(this.pickInput).h(30).text_size(13))
        .child(h_flex().gap(12).items_start()
          .child(list)
          .when(wide && !!cur && !cur.create, e => e.child(v_flex().gap(6).flex_shrink_0()
            .child(this.boardPreview(cur.path, 300, 200, t))
            .child(div().w(300).truncate().text_size(11).text_color(t.dim).child(tilde(cur.path, home())))))));
  }

  maybeFit() { if (!this.fitted && this.measured && this.ed.doc.live().length) { this.fitted = true; this.ed.fit(); } }

  // The demo: a fresh Editor on core/demo.js's board, played at once. The person's editor (and its
  // file store, which holds it) waits in this.board, still taking the file's outside changes.
  startDemo() {
    if (!this.board) this.board = this.ed;
    const ed = new Editor({ scene: demoScene() });
    ed.setSize(this.size.w, this.size.h); ed.fit(); ed.playToggle();
    this.ed = ed; this.help = false; this.flash = null;
  }
  endDemo() {
    if (!this.board) return;
    this.ed = this.board; this.board = null; this.ed.setSize(this.size.w, this.size.h); this.flash = "back to your board";
  }

  // After every event: keep the text box, timer and agent selection file in step.
  after(cx) {
    if (this.panelOnly) return this.panelAfter(cx);
    const ed = this.ed;
    if (ed.text && !this.textOpen) {
      this.textOpen = true; this.input.set_value(ed.text.value);
      // The Input isn't drawn yet, so it can't take the keyboard now: ask again after the frame.
      this.input.focus();
      cx.timer.after(30, () => { if (this.ed.text && !this.inputFocused) this.input.focus(); });
    }
    if (!ed.text && this.textOpen) { this.textOpen = false; this.handle.focus(); }
    if (ed.needsTick() && !this.tick) {
      this.tick = cx.timer.every(16, cx2 => {
        ed.tick();
        if (!ed.needsTick()) { this.tick?.cancel(); this.tick = null; }
        cx2.notify();
      });
    }
    const key = [...ed.sel].sort().join(",");
    // Not mid-gesture: a marquee changes the selection on every mouse move.
    if (key !== this.selKey && !ed.g && !this.board) { this.selKey = key; this.writeSelection(); }
    if (this.dirty && this.store) { this.dirty = false; this.store.schedule(cx); }
    if (!ed.g) this.store?.flushPending(cx);
    useBoard(this); ping("board");   // the popped-out panel shows this board
    cx.notify();
  }

  writeSelection() {
    const els = this.ed.selected().map(el => {
      const label = isShape(el) ? this.ed.doc.labelOf(el)?.text : el.type === "text" ? el.text : undefined;
      return { id: el.id, type: el.type, x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height), label, layer: layerOf(el) };
    });
    exec("sh", ["-c", 'mkdir -p "$1" && printf %s "$2" > "$1/selection.json"', "sel", CACHE(), JSON.stringify({ file: this.file, at: new Date().toISOString(), selected: els })]);
  }

  // ── input ──────────────────────────────────────────────────────────────

  pt(e) { const z = Z(); return { x: e.local_position.x / z, y: e.local_position.y / z }; }
  mods(e) { const m = e.modifiers ?? {}; return { shift: m.shift, alt: m.alt, cmd: m.platform, ctrl: m.control, clickCount: e.click_count ?? 1, button: e.button }; }

  // Typing while the text box doesn't have the keyboard: type into it from here.
  typeFallback(e, cx) {
    const m = e.modifiers ?? {}, v = this.input.value();
    let next = null;
    if (e.key === "enter" && (m.platform || m.control)) { this.ed.commitText(); this.after(cx); return true; }
    if (m.platform || m.control) return false;
    if (e.key === "enter") next = v + "\n";
    if (e.key === "escape") { this.ed.commitText(); this.after(cx); return true; }
    else if (e.key === "backspace") next = v.slice(0, -1);
    else if (e.key === "space") next = v + " ";
    else { const ch = e.key_char ?? (e.key.length === 1 ? (m.shift ? e.key.toUpperCase() : e.key) : null); if (ch) next = v + ch; }
    if (next === null) return false;
    this.input.set_value(next); this.ed.setText(next); this.after(cx);
    return true;
  }

  keys(e, cx) {
    if (this.renaming) return;
    if (this.hexFocused) {   // typing a hex: Escape closes the picker, every other key is the field's
      if (e.key === "escape") { this.closeColorPick(); this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (this.picker) return this.pickKeys(e, cx);
    if (!this.ed.text && (e.modifiers?.platform || e.modifiers?.control) && !e.modifiers?.shift && e.key === "o") { this.openPicker(cx); cx.stop_propagation(); return cx.notify(); }
    if (this.help) {   // the overlay takes every key: ? or Esc closes it, D plays the demo
      if (e.key === "d" && !e.modifiers?.platform) this.startDemo();
      else if (isHelpKey(e) || e.key === "escape" || e.key === "q") this.help = false;
      cx.stop_propagation(); return this.after(cx);
    }
    if (!this.ed.text && isHelpKey(e)) { this.help = true; cx.stop_propagation(); return this.after(cx); }
    if (this.board && !this.ed.text && e.key === "escape") { this.endDemo(); cx.stop_propagation(); return this.after(cx); }
    if (this.ed.text && !this.inputFocused) { if (this.typeFallback(e, cx)) cx.stop_propagation(); return; }
    if (this.ed.text && (e.key === "escape" || (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)))) { this.ed.setText(this.input.value()); this.ed.commitText(); cx.stop_propagation(); return this.after(cx); }
    const ed = this.ed, m = e.modifiers ?? {}, mm = { shift: m.shift, alt: m.alt, cmd: m.platform, ctrl: m.control };
    const cmd = m.platform || m.control;   // ⌃ works wherever ⌘ does (the person's Herdr may own the ⌘ key)
    if (!ed.text && cmd && !m.shift && (e.key === "c" || e.key === "x")) {
      // The system clipboard gets Excalidraw's format, so paste works in excalidraw.com too.
      const text = ed.copy();
      if (text) { exec("sh", ["-c", 'printf %s "$1" | LANG=en_US.UTF-8 pbcopy', "copy", text]); if (e.key === "x") ed.deleteIds([...ed.sel]); this.flash = "copied"; }
      cx.stop_propagation(); return this.after(cx);
    }
    if (!ed.text && cmd && !m.shift && e.key === "v") {
      cx.spawn(async cx => {
        const r = await exec("sh", ["-c", "LANG=en_US.UTF-8 pbpaste"]);
        if ((r.stdout ?? "").trim()) ed.paste(r.stdout);
        else {   // no text: maybe a picture (pbpaste only gives text)
          const c = await exec("sh", ["-c", CLIP_SH, "img-clip", `${IMG_DIR()}/clip-${Date.now()}.png`]);
          if (c.code === 0 && c.stdout) await this.importImages([c.stdout.trim()], true);
        }
        this.after(cx);
      });
      cx.stop_propagation(); return;
    }
    if (!ed.text && cmd && m.shift && e.key === "e") { if (this.board) { this.flash = "the demo isn't saved or exported: Esc goes back to your board"; cx.stop_propagation(); return this.after(cx); } cx.spawn(async cx => { await this.exportBoard(); cx.notify(); }); cx.stop_propagation(); return this.after(cx); }
    if (!ed.text && !m.platform && !m.control && e.key === "i") { if (popoutId()) this.togglePopout(); else this.sidebar = !this.sidebar; cx.stop_propagation(); return this.after(cx); }
    if (ed.key(e.key, mm)) { cx.stop_propagation(); this.after(cx); }
  }

  // Image files onto the board (dropped, pasted), side by side around the view's center.
  async importImages(paths, removeAfter = false) {
    const ed = this.ed, c = ed.toWorld({ x: this.size.w / 2, y: this.size.h / 2 }), ids = [];
    for (const [i, p] of paths.entries()) {
      const r = await exec("sh", ["-c", IMPORT_SH, "img-import", p, IMG_DIR()]);
      if (removeAfter) exec("rm", ["-f", p]);
      const [id, mimeType, dims, b64] = (r.stdout ?? "").split("\n");
      if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(id ?? "") || !b64) { this.flash = `Can't import ${p.split("/").pop()}`; continue; }
      const [width, height] = (dims ?? "").trim().split(/\s+/).map(Number);
      this.imgs.set(id, `${IMG_REL}/${id}.${MIME_EXT[mimeType] ?? "svg"}`);   // id: our own hash of the bytes, checked above
      ids.push(ed.addImage({ id, mimeType, dataURL: `data:${mimeType};base64,${b64}`, width: width || 400, height: height || 300 }, { x: c.x + i * 30, y: c.y + i * 30 }));
    }
    if (ids.length > 1) ed.select(ids);
  }

  // Board images (opened, merged from drawh or a peer) decoded into the cache image() reads.
  // The base64 goes through a temp file: as an argument it could pass macOS's ~1 MB argv limit.
  ensureImages(cx) {
    const files = this.ed.doc.files, todo = Object.keys(files).filter(id => !this.imgs.has(id));
    if (!todo.length) return;
    for (const id of todo) this.imgs.set(id, "pending");
    cx.spawn(async cx => {
      await exec("mkdir", ["-p", IMG_DIR()]);
      for (const id of todo) {
        const f = files[id], m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(f?.dataURL ?? "");
        if (!m || !MIME_EXT[m[1]]) { this.imgs.set(id, "failed"); continue; }
        // Cache files are named by the SHA-1 of their decoded bytes, never by the board's id: a
        // board can claim any id, and must not get another board's picture shown under it.
        try {
          const tmp = `${IMG_DIR()}/in-${Date.now()}-${Math.floor(Math.random() * 1e6)}.b64`;
          await writeText(tmp, m[2], null);
          const r = await exec("sh", ["-c", 'set -e; trap \'rm -f "$1" "$1.bin"\' EXIT; base64 -D < "$1" > "$1.bin"; h=$(shasum -a 1 < "$1.bin" | cut -c1-40); [ -s "$2/$h.$3" ] || mv "$1.bin" "$2/$h.$3"; printf %s "$h"', "img-cache", tmp, IMG_DIR(), MIME_EXT[m[1]]]);
          const h = (r.stdout ?? "").trim();
          if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(h)) throw new Error(r.stderr || "base64 failed");
          this.imgs.set(id, `${IMG_REL}/${h}.${MIME_EXT[m[1]]}`);
        } catch { this.imgs.set(id, "failed"); }
        cx.notify();
      }
    });
  }

  canvasEvents(el) {
    const ed = this.ed;
    return el
      .on_drop((e, cx) => {
        const libs = (e?.paths ?? []).filter(p => /\.excalidrawlib$/i.test(p));
        if (libs.length) { cx.spawn(async cx => { await this.importLibraries(libs); this.after(cx); }); return; }
        const paths = (e?.paths ?? []).filter(p => IMAGE_FILE.test(p));
        if (!paths.length) { this.flash = "drop images or .excalidrawlib libraries here"; return this.after(cx); }
        cx.spawn(async cx => { await this.importImages(paths); this.after(cx); });
      })
      .on_size_change((size, cx) => {
        const z = Z(), w = size.width / z, h = size.height / z;
        if (Math.abs(w - this.size.w) > 1 || Math.abs(h - this.size.h) > 1) { this.size = { w, h }; this.measured = true; ed.setSize(w, h); this.maybeFit(); cx.notify(); }
      })
      .on_mouse_down("left", (e, cx) => { if (!e.local_position) return; this.handle.focus(); ed.pointerDown(this.pt(e), this.mods(e)); this.after(cx); })
      .on_mouse_down("middle", (e, cx) => { if (!e.local_position) return; ed.pointerDown(this.pt(e), { ...this.mods(e), button: "middle" }); this.after(cx); })
      .on_mouse_move((e, cx) => { const v = ed.version; ed.pointerMove(this.pt(e), this.mods(e)); if (ed.version !== v) this.after(cx); })
      .on_mouse_up("left", (e, cx) => { if (!e.local_position) return; ed.pointerUp(this.pt(e), this.mods(e)); this.after(cx); })
      .on_mouse_up("middle", (e, cx) => { if (!e.local_position) return; ed.pointerUp(this.pt(e), this.mods(e)); this.after(cx); })
      // GPUI reports releases only over the element: leaving mid-drag ends the drag where it was.
      .on_hover((hovered, cx) => { if (!hovered && ed.g && ed.g.kind !== "poly") { ed.pointerUp(ed.g.last ?? { x: 0, y: 0 }, {}); this.after(cx); } })
      .on_scroll_wheel((e, cx) => { const z = Z(), m = e.modifiers ?? {}; ed.wheel({ x: e.delta.x / z, y: e.delta.y / z }, e.local_position ? this.pt(e) : undefined, { cmd: m.platform, ctrl: m.control }); this.after(cx); });
  }

  // ⌘⇧E or `herdr-app do herdr-draw.export`: board.svg and board.png (2×, at most 4096 px)
  // next to the board, cropped to the drawing, on the board's own page color. The PNG is the
  // same SVG rasterized by macOS's sips, which renders embedded pictures and any script.
  async exportBoard() {
    if (this.machine) { this.flash = `this board lives on ${this.machine}: export it there with drawh export`; return; }
    const doc = (this.board ?? this.ed).doc, theme = boardTheme(doc.appState), base = this.file.replace(/\.excalidraw(\.json)?$/, "");
    const name = p => p.split("/").pop();
    try {
      const flat = exportScene(doc, theme, { scale: 1 });
      const svg = toSvg(flat.items, flat);
      // Never as a shell argument: a board's SVG with photos passes macOS's ~1 MB argv limit.
      await writeText(`${base}.svg`, svg, await readText(`${base}.svg`));
      const big = exportScene(doc, theme, { scale: 2, maxPixels: 4096 });
      // The SVG to rasterize waits in the cache, not beside the board: the board's folder is watched.
      const dir = `${appHome()}/.cache/herdr-draw/tmp`, tmp = `${dir}/export-${Date.now()}.svg`;
      await exec("mkdir", ["-p", dir]);
      // See toSvg: no nested SVGs for sips, and one font per class (the pane's own faces), which sips can find.
      const faces = { ...RASTER_FACES, hand: this.face("hand") ?? RASTER_FACES.hand, mono: this.face("mono") ?? RASTER_FACES.mono };
      await writeText(tmp, toSvg(big.items, { ...big, svgImages: false, faces }), null);
      const r = await exec("sh", ["-c", 'sips -s format png "$1" --out "$2" >/dev/null 2>&1; s=$?; rm -f "$1"; exit $s', "png-export", tmp, `${base}.png`]);
      if (r.code !== 0) throw new Error(`sips couldn't make the PNG (${r.stderr || r.code})`);
      this.flash = `exported ${name(base)}.svg + .png`;
    } catch (e) { this.error = `Export failed: ${e?.message ?? e}`; }
  }

  // Excalidraw font classes → installed fonts: hand-drawn if one exists, the terminal font for mono.
  face(cls) {
    if (cls === "mono") return settings().font_family || "Menlo";
    if (cls !== "hand") return null;
    if (this.handFace === undefined) {
      let have = []; try { have = (fonts?.() ?? []).map(f => (typeof f === "string" ? f : f?.name ?? f?.family)).filter(Boolean); } catch { have = []; }
      this.handFace = ["Excalifont", "Virgil", "Chalkboard SE", "Comic Sans MS"].find(f => have.includes(f)) ?? null;
    }
    return this.handFace;
  }

  palette() { const t = theme(); return { fg: t.foreground, bg: t.background, accent: t.accent, dim: t.dim ?? t.muted }; }

  // ── paint ──────────────────────────────────────────────────────────────

  render(cx) {
    const t0 = Date.now(), view = this.renderView(cx);
    // How long redraws take, in Herdr's own runtime: `herdr-app do herdr-draw.perf` writes the last ones.
    (this.perf ??= []).push(Date.now() - t0);
    if (this.perf.length > 60) this.perf.shift();
    return view;
  }

  // <cache>/perf.json: this board's size and its last redraw times (ms), for finding slow boards.
  writePerf() {
    const ms = [...(this.perf ?? [])], sorted = [...ms].sort((a, b) => a - b);
    const dl = this.ed.displayList(this.palette()), b = batchPaths(dl);
    cx_free_write(CACHE(), "perf.json", JSON.stringify({ at: new Date().toISOString(), file: this.file, machine: this.machine,
      elements: this.ed.doc.live().length, zoom: this.ed.view.scale, items: dl.length, drawCalls: b.layers.length, texts: b.texts.length,
      cmds: dl.reduce((n, i) => n + (i.cmds?.length ?? 0), 0), renders: ms.length, last: ms.slice(-10),
      median: sorted[sorted.length >> 1] ?? null, max: sorted[sorted.length - 1] ?? null }));
  }

  renderView(cx) {
    const t = theme();
    if (this.panelOnly) return this.panelWindow(t);
    this.ensureImages(cx);
    const side = panelLayout({ ...panelState(), open: this.sidebar && !popoutId() }, this.size.w + this.sideW);
    this.sideW = side.width;
    cx.spawn(async acx => { await this.drawRotated(acx); await this.loadPreviews(acx); });   // after this frame: rotated text PNGs, picker previews
    return v_flex().id("draw").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.keys(e, cx))
      // Panel drags (its edge, a section title) follow the pointer anywhere in the pane; GPUI has no
      // release outside it, so leaving the pane ends them.
      .on_mouse_move((e, cx) => this.panelMove(e, cx))
      .on_mouse_up("left", (_e, cx) => this.panelDragEnd(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.panelDragEnd(cx); })
      .child(this.toolbar(t))
      .child(h_flex().flex_1().min_h(0).w_full()
        .child(this.canvas(t))
        .when(side.show, el => el.child(this.sidePanel(t, side.width))))
      .when(this.ed.duration() > 1 || !!this.ed.play, el => el.child(this.timeline(t)));
  }

  button(t, id, label, active, tip, fn) {
    return div().id(id).h(26).min_w(26).px(5).rounded(6).flex().items_center().justify_center().gap(3)
      .bg(active ? t.accent : CLEAR).text_color(active ? t.accent_foreground : t.foreground)
      .hover(s => s.bg(active ? t.accent : t.hover)).cursor_pointer().tooltip(this.kk(tip))
      .on_click((_e, cx) => { fn(); this.handle.focus(); this.after(cx); }).child(label);
  }

  toolbar(t) {
    const ed = this.ed, name = (this.file ?? "").split("/").pop();
    const status = this.error ?? this.flash ?? ed.flash ?? `${ed.doc.visible().filter(e => !isLabel(e)).length} elements`;
    const badges = this.size.w + this.sideW >= BADGES_MIN_W;
    // Each tool shows its key beside its icon (as Excalidraw does), unless the pane is narrow.
    const labelled = (icon, key, size = 14) => h_flex().items_center().gap(2).child(div().text_size(size).child(icon))
      .when(badges && !!key, e => e.child(div().text_size(9).opacity(0.65).child(key)));
    return h_flex().id("draw-bar").w_full().h(36).px(6).gap(1).items_center().border_b(1).border_color(t.border).bg(t.surface ?? t.background).flex_shrink_0()
      .children(TOOLS.map(tool => this.button(t, `tool-${tool.id}`, labelled(tool.icon, tool.keys[0].toUpperCase()), ed.tool === tool.id, `${tool.name} (${tool.keys.map(k => k.toUpperCase()).join(" or ")})`, () => ed.setTool(tool.id))))
      .child(div().w(1).h(18).mx(4).bg(t.border))
      .child(this.button(t, "lock", labelled(ed.toolLock ? "🔒" : "🔓", "Q", 12), ed.toolLock, "Keep the tool after drawing (Q)", () => ed.key("q")))
      .child(this.button(t, "undo", div().text_size(14).child("↶"), false, "Undo (⌘Z)", () => ed.undo()))
      .child(this.button(t, "redo", div().text_size(14).child("↷"), false, "Redo (⌘⇧Z)", () => ed.redo()))
      .child(this.button(t, "grid", div().text_size(13).child("▦"), !!ed.grid, "Snap to grid (⌘')", () => ed.key("'", { cmd: true })))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(this.error ? t.blocked : t.dim).truncate().child(status))
      .child(div().w(8))
      .child(this.button(t, "zoom", div().text_size(11).text_color(t.muted).child(`${Math.round(ed.view.scale * 100)}%`), false, "Fit everything (⇧1)", () => ed.fit()))
      .child(this.button(t, "side", labelled("◧", "I", 13), this.sidebar && !popoutId(), popoutId() ? "Dock the panel back here (I)" : "Properties and layers (I)",
        () => { if (popoutId()) this.togglePopout(); else this.sidebar = !this.sidebar; }))
      .child(this.button(t, "help", div().text_size(13).font_semibold().child("?"), this.help, "Every shortcut, and a demo (?)", () => { this.help = !this.help; }))
      .child(div().id("board-name").ml(4).px(6).h(24).rounded(5).flex().items_center().gap(4).cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Switch board or make a new one (⌘O)")
        .on_click((_e, cx) => { this.openPicker(cx); cx.notify(); })
        .child(div().text_size(12).text_color(t.muted).truncate().child(this.file ? (this.machine ? `${this.machine} · ` : "") + boardName(name) : "no board")).child(div().text_size(9).text_color(t.dim).child("▾")));
  }

  canvas(t) {
    const { layers, texts } = batchPaths(this.ed.displayList(this.palette()));
    // The editor names the cursor for what's under the pointer (handles, shapes, connection points).
    const el = cursorStyle(div().id("draw-canvas").flex_1().min_w(0).h_full().relative().overflow_hidden(), this.ed.cursor());
    return this.canvasEvents(el)
      .children(layers.filter(l => l.n).map(l => l.img ? this.imageItem(l.img, t) : div().absolute().top(0).left(0).size_full().child(window.paint_path(l.b.build(), l.color))))
      .children(texts.map(it => this.textItem(it, t)))
      .when(!!this.file && !this.ed.doc.live().length && !this.error, e => e.child(this.emptyHint(t)))
      .when(!!this.ed.text, e => e.child(this.textInput(t)))
      .when(!!this.board, e => e.child(this.demoBar(t)))
      .when(this.help, e => e.child(this.helpOverlay(t)))
      .when(!!this.picker, e => e.child(this.pickerOverlay(t)))
      .when(!this.file && !this.picker, e => e.child(this.noBoard(t)));
  }

  // ── library ──────────────────────────────────────────────────────────

  async importLibraries(paths) {
    let n = 0;
    for (const p of paths) {
      try {
        const items = parseLibrary(await readText(p) ?? "");
        await this.lib.update(cur => { const next = mergeLibrary(cur, items); n += next.length - cur.length; return next; });
      } catch (e) { this.flash = `Can't read ${p.split("/").pop()}: ${e?.message ?? e}`; return; }
    }
    this.previews.clear();
    this.flash = `library: ${n} item${n === 1 ? "" : "s"} added`;
  }

  saveToLibrary(cx) {
    const item = this.ed.libraryItem();
    if (!item) { this.flash = "select something to save it to the library"; return; }
    cx.spawn(async cx => { if (await this.lib.update(cur => [item, ...cur])) this.flash = `saved "${item.name ?? "item"}" to the library`; cx.notify(); });
  }

  removeFromLibrary(id, cx) {
    cx.spawn(async cx => { await this.lib.update(cur => cur.filter(i => i.id !== id)); this.previews.delete(id); cx.notify(); });
  }

  // A small drawing of the item: paths only (text and pictures are left out), fitted into w × h.
  preview(item, w, h) {
    let p = this.previews.get(item.id);
    if (!p) {
      const pal = this.palette(), doc = new Doc({ elements: item.elements, files: {} });
      const box = paintedBox(doc, pal) ?? { x: 0, y: 0, w: 1, h: 1 }, pad = 3;
      const k = Math.min(1, (w - pad * 2) / Math.max(1, box.w), (h - pad * 2) / Math.max(1, box.h));
      const ox = (w - box.w * k) / 2, oy = (h - box.h * k) / 2;
      const items = paintScene(doc, { x: ox / k - box.x, y: oy / k - box.y, scale: k }, pal).filter(i => i.t === "path");
      p = batchPaths(items).layers.filter(l => l.n && !l.img);
      this.previews.set(item.id, p);
    }
    return div().relative().w(w).h(h).overflow_hidden().rounded(4).bg(withAlpha(this.palette().fg, 0.04))
      .children(p.map(l => div().absolute().top(0).left(0).size_full().child(window.paint_path(l.b.build(), l.color))));
  }

  libraryPanel(t) {
    const items = this.lib.items, W = 64, H = 44;
    const tiles = items.map(item => v_flex().id(`lib-${item.id}`).w(W + 8).p(4).gap(2).rounded(6).hover(s => s.bg(t.hover)).cursor_pointer()
      .tooltip(`Insert "${item.name ?? "item"}" (${item.elements.length} elements)`)
      .on_click((_e, cx) => { this.ed.insertLibraryItem(item); this.handle.focus(); this.after(cx); })
      .child(this.preview(item, W, H))
      .child(h_flex().w_full().gap(2).items_center()
        .child(div().flex_1().truncate().text_size(10).text_color(t.muted).child(item.name ?? "item"))
        .child(div().id(`lib-rm-${item.id}`).text_size(10).text_color(t.dim).hover(s => s.text_color(t.foreground)).tooltip("Remove from the library")
          .on_click((_e, cx) => { cx.stop_propagation(); this.removeFromLibrary(item.id, cx); }).child("✕"))));
    const body = v_flex().gap(6)
      .child(h_flex().flex_wrap().gap(2).children(tiles))
      .when(!items.length, e => e.child(div().text_size(11).text_color(t.dim).child("Save a selection with +, or drop a .excalidrawlib")))
      .child(h_flex().gap(4)
        .child(this.chip(t, "lib-add", "+ save selection", false, "Save the selection to the library", cx => this.saveToLibrary(cx), 100)));
    return this.section(t, `Library · ${items.length}`, body);
  }

  // GPUI can't rotate an image: like text, it stays upright here (SVG export turns it).
  imageItem(it, t) {
    const path = this.imgs.get(it.fileId), box = div().absolute().left(it.x).top(it.y).w(it.w).h(it.h);
    if (path && path !== "pending" && path !== "failed") return box.child(image(path).size_full().opacity(Math.max(0, Math.min(1, it.opacity ?? 1))));
    return box.border(1).border_color(t.border).bg(withAlpha(t.dim, 0.12)).flex().items_center().justify_center()
      .child(div().text_size(11).text_color(t.dim).child(path === "failed" ? "image unavailable" : "loading image…"));
  }

  // A rotated text item as a picture: the item moved into a square around its center, drawn by
  // toSvg (rotation, escaping, one font per class for sips) at 2 × the pane's zoom. Until its PNG
  // exists, the previous one (mid-rotation) or the upright text stands in.
  rotatedItem(it, text, t) {
    const lines = text.split("\n"), lh = it.size * (it.lineHeight ?? 1.25);
    const w = it.box ? it.box.w : Math.max(...lines.map(l => l.length)) * it.size * 0.75 + it.size, h = it.box ? it.box.h : lines.length * lh + it.size * 0.5;
    const x0 = it.box ? it.box.x : it.x, y0 = it.box ? it.box.y : it.y;
    const R = Math.ceil(Math.hypot(Math.max(Math.abs(x0 - it.cx), Math.abs(x0 + w - it.cx)), Math.max(Math.abs(y0 - it.cy), Math.abs(y0 + h - it.cy))) + it.size * 0.5);
    const ox = it.cx - R, oy = it.cy - R, deg = Math.round(it.angle * 180 / Math.PI);   // whole degrees: a drag doesn't make hundreds of PNGs
    const local = { ...it, text, angle: deg * Math.PI / 180, x: it.x - ox, y: it.y - oy, cx: R, cy: R, box: it.box && { ...it.box, x: it.box.x - ox, y: it.box.y - oy }, color: it.color ?? t.foreground, reveal: undefined };
    const faces = { ...RASTER_FACES, hand: this.face("hand") ?? RASTER_FACES.hand, mono: this.face("mono") ?? RASTER_FACES.mono };
    const svg = toSvg([local], { width: 2 * R, height: 2 * R, scale: 2 * Z(), svgImages: false, faces });
    const key = fnv(svg), e = this.rtext.get(it.id) ?? {};
    if (e.key !== key) { e.want = { key, svg }; this.rtext.set(it.id, e); }
    if (!e.path) return null;
    return div().absolute().left(ox).top(oy).w(2 * R).h(2 * R).child(image(e.path).size_full());
  }

  // Draw the PNGs rotated text wants, one job per element at a time; the newest wish wins.
  async drawRotated(cx) {
    for (const [id, e] of this.rtext) {
      if (e.busy || !e.want || e.want.key === e.key) continue;
      e.busy = true;
      try {
        while (e.want && e.want.key !== e.key) {
          const { key, svg } = e.want, rel = `${TXT_REL}/${key}.png`, tmp = `${TXT_DIR()}/${key}.svg`;
          await writeText(tmp, svg, null);
          const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")"; [ -s "$2" ] || sips -s format png "$1" --out "$2" >/dev/null 2>&1; s=$?; rm -f "$1"; exit $s', "txt-raster", tmp, `${appHome()}/${rel}`]);
          if (r.code !== 0) { e.want = null; break; }   // stays upright rather than retrying every frame
          e.key = key; e.path = rel;
          cx.notify();
        }
      } finally { e.busy = false; }
    }
    // Forget elements that are gone or upright again.
    for (const id of this.rtext.keys()) { const el = this.ed.doc.get(id) ?? this.ed.doc.get(id.split(":")[0]); if (!el) this.rtext.delete(id); }
  }

  textItem(it, t) {
    let text = String(it.text ?? "");
    if (it.reveal != null && it.reveal < 1) text = text.slice(0, Math.round(text.length * it.reveal));   // typewriter
    if (it.angle && Math.abs(it.angle) > 0.001) { const pic = this.rotatedItem(it, text, t); if (pic) return pic; }
    const face = this.face(it.font);
    const lines = v_flex().when(!!face, e => e.font_family(face)).text_size(it.size).line_height(it.lineHeight ?? 1.25).text_color(withAlpha(it.color ?? t.foreground, it.opacity ?? 1))
      .children(text.split("\n").map(l => div().whitespace_nowrap().child(l || " ")));
    if (it.box) return div().absolute().left(it.box.x).top(it.box.y).w(it.box.w).h(it.box.h).flex().items_center().justify_center().text_center().child(lines.items_center());
    return div().absolute().left(it.x).top(it.y).child(lines);
  }

  textInput(t) {
    const b = this.ed.textBox(); if (!b) return div();
    return div().absolute().left(b.x).top(b.y).w(b.w).min_h(b.h).px(6).py(3).rounded(6).border(1).border_color(t.accent).bg(t.background)
      .child(Textarea.new(this.input).w_full().text_size(Math.min(28, b.size)).text_color(t.foreground));
  }

  emptyHint(t) {
    return div().absolute().top(0).left(0).size_full().flex().items_center().justify_center()
      .child(v_flex().items_center().gap(6).text_color(t.dim).text_size(13)
        .child(div().text_size(16).text_color(t.muted).child("Empty board"))
        .child(div().child("r ▭   d ◇   o ◯   a →   l ╱   p ✎   t T   f frame   e eraser   k laser"))
        .child(div().child(this.kk("double-click to write · drag empty space to select · ⌘Z undo · I panels · ? every key")))
        .child(div().child("drop or paste an image to put it on the board"))
        .child(div().child("agents: drawh add / arrow / ls / sel"))
        .child(h_flex().gap(8).mt(6)
          .child(this.chip(t, "hint-help", "?  every shortcut", false, "Every shortcut (?)", () => { this.help = true; }, 120))
          .child(this.chip(t, "hint-demo", "▶  play the demo", false, "A short animated tour (not saved)", () => this.startDemo(), 120))));
  }

  noBoard(t) {
    return div().absolute().top(0).left(0).size_full().flex().items_center().justify_center()
      .child(v_flex().items_center().gap(8).text_color(t.dim).text_size(13)
        .child(div().text_size(16).text_color(t.muted).child("No board open"))
        .child(this.chip(t, "nb-pick", "open or make a board  ⌘O", false, "Pick a board (⌘O)", cx => this.openPicker(cx), 180)));
  }

  // Over the canvas while the demo plays: what this is, and the way back.
  demoBar(t) {
    return h_flex().id("demo-bar").absolute().top(8).left(0).w_full().justify_center()
      .child(h_flex().gap(8).px(10).py(4).items_center().rounded(8).border(1).border_color(t.accent).bg(t.surface ?? t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().text_size(12).text_color(t.foreground).font_semibold().child("DEMO"))
        .child(div().text_size(12).text_color(t.muted).child("try anything, nothing is saved"))
        .child(this.chip(t, "demo-replay", "↻ replay  ⇧Space", false, "Play it again (⇧Space)", () => { this.ed.stopPlay(); this.ed.playToggle(); }, 110))
        .child(this.chip(t, "demo-exit", "✕ back to my board  Esc", false, "Leave the demo (Esc)", () => this.endDemo(), 150)));
  }

  // ?: every shortcut from core/shortcuts.js, in columns. Esc, ? or a click outside closes it.
  helpOverlay(t) {
    const kb = k => div().flex_shrink_0().px(5).h(18).rounded(4).border(1).border_color(t.border).bg(withAlpha(t.foreground, 0.05))
      .flex().items_center().text_size(11).font_semibold().text_color(t.foreground).child(k);
    const group = ([title, rows]) => v_flex().gap(3).w(320)
      .child(div().text_size(10).font_semibold().text_color(t.dim).mb(2).child(title.toUpperCase()))
      .children(rows.map(([keys, what]) => h_flex().gap(8).items_center()
        .child(h_flex().w(104).flex_shrink_0().justify_end().child(kb(this.kk(keys))))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(this.kk(what)))));
    const moved = SHORTCUTS.flatMap(([, rows]) => rows).filter(([k]) => this.kk(k) !== k).map(([k]) => k);   // min_w(0): long ones wrap, never spill into the next column
    return div().id("help-overlay").absolute().top(0).left(0).size_full().bg(withAlpha(t.background, 0.82)).flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.help = false; this.after(cx); })
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(v_flex().id("help-card").max_h_full().max_w_full().overflow_y_scroll().gap(14).p(18).rounded(10).border(1).border_color(t.border).bg(t.surface ?? t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(16).font_semibold().child("Shortcuts"))
          .child(div().flex_1())
          .child(this.chip(t, "help-demo", "▶  play the demo  D", false, "A short animated tour (not saved)", () => this.startDemo(), 130))
          .child(this.chip(t, "help-close", "close  Esc", false, "Close (Esc or ?)", () => { this.help = false; }, 70)))
        .when(moved.length > 0, e => e.child(div().text_size(11).text_color(t.dim).child(`⌃ where you'd expect ⌘: your Herdr keys (keys.json) already use ${moved.join(", ").replace(/\s+/g, " ")}, so this board answers to ⌃ for them.`)))
        .child(h_flex().flex_wrap().gap(18).items_start().children(SHORTCUTS.map(group))));
  }

  // ── the popped-out panel ─────────────────────────────────────────────
  // The side panel in a Herdr window of its own (openOverlay kind "window"), kept across restarts.
  // It is this view in panel-only mode: no editor, file or command loop of its own; it shows and
  // changes the board pane used last (panes.js), and each side wakes the other to redraw and save.

  togglePopout() {
    const id = popoutId();
    if (id) { closeOverlay(id); setPopout(null); this.sidebar = true; return; }
    const w = Math.round(panelState().width ?? WIDTH.default);
    setPopout(openOverlay({ mod: MOD, kind: "window", key: `${MOD}.panel`, keep: true, width: w + 2, height: 0.8, props: { panel: true } }));
  }

  initPanel(p, cx) {
    this.panelOnly = true; this.overlay = p.overlay ?? null;
    this.handle = cx.focus_handle();
    this.taken = new Set(); this.loadKeys(cx);
    this.imgs = new Map(); this.size = { w: 300, h: 600 }; this.ownFlash = null;
    // The board's own editor, library and status line; nothing here when no board of this build is open.
    Object.defineProperty(this, "ed", { get: () => activeBoard()?.ed ?? null, configurable: true });
    Object.defineProperty(this, "lib", { get: () => activeBoard()?.lib ?? null, configurable: true });
    Object.defineProperty(this, "flash", { get: () => activeBoard()?.flash ?? this.ownFlash, set: v => { const b = activeBoard(); if (b) b.flash = v; else this.ownFlash = v; }, configurable: true });
    this.panelInputs();
    if (this.overlay) setPopout(this.overlay);   // a kept window, reopened at start: the board panes dock theirs
    cx.spawn(async acx => { await loadPanel(); acx.notify(); for (;;) { await panelChanged(); acx.notify(); } });
    this.changes = listen();
    cx.spawn(async acx => { for (;;) { const what = await this.changes.next(); if (what !== "panel") acx.notify(); } });
  }

  // The panel window's after(): the board saves and redraws on its own loop, with its own cx.
  panelAfter(cx) { ping("panel"); cx.notify(); }

  panelWindow(t) {
    const b = activeBoard(), name = b?.file ? boardName(b.file.split("/").pop()) : null;
    const st = panelState(), rows = b ? panelSections(st, id => this.sectionAvailable(id)) : [];
    // The strip on top drags the window; every press below it stops, so controls don't drag it.
    const strip = h_flex().id("pop-strip").w_full().h(28).px(8).gap(6).items_center().flex_shrink_0().border_b(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.dim).child("◧"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(name ? `${b.machine ? `${b.machine} · ` : ""}${name}` : "herdr-draw"))
      .child(div().id("pop-dock").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.chip(t, "pop-dock-btn", "dock", false, "Put the panel back beside the board", () => { closeOverlay(this.overlay); setPopout(null); }, 40)));
    const body = v_flex().id("pop-body").w_full().flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (!b) return v_flex().id("draw-pop").size_full().bg(t.surface ?? t.background).text_color(t.foreground).child(strip)
      .child(body.p(12).gap(8)
        .child(div().text_size(12).text_color(t.muted).child("No board open on this build of herdr-draw. Open a board (⌘⇧B), or reopen its pane: a pane opened before an update runs the older build."))
        .child(this.chip(t, "pop-close", "close", false, "Close this window", () => { closeOverlay(this.overlay); setPopout(null); }, 48)));
    const content = this.customize ? [this.panelSettings(t, st)] : rows.filter(r => r.active).map(r => this.sectionBlock(t, r, st.mode)).filter(Boolean);
    return v_flex().id("draw-pop").size_full().bg(t.surface ?? t.background).text_color(t.foreground)
      .on_mouse_move((e, cx) => this.panelMove(e, cx)).on_mouse_up("left", (_e, cx) => this.panelDragEnd(cx))
      .child(strip)
      .child(body.child(this.panelBar(t, st, rows)).child(v_flex().id("side-scroll").w_full().flex_1().min_h(0).overflow_y_scroll().children(content)));
  }

  // `herdr-app do herdr-draw.import`: the picture paths listed in <appHome>/herdr-draw/import.json go on the board
  // (as a drop would put them), then the list is removed. For checks that can't drag or paste.
  async importQueued() {
    const f = `${appHome()}/herdr-draw/import.json`;
    let paths = [];
    try { paths = JSON.parse(await readTextFile(f) ?? "[]"); } catch { paths = []; }
    exec("rm", ["-f", f]);
    if (Array.isArray(paths) && paths.length) await this.importImages(paths.filter(x => typeof x === "string"));
  }

  // ── panels ─────────────────────────────────────────────────────────────

  // A section's title and body; sidePanel draws them (stacked with a foldable title, or as a tab).
  section(_t, title, body) { return { title, body }; }

  sectionContent(t, id) {
    return ({ properties: () => this.properties(t), arrange: () => this.arrange(t), frames: () => this.framesPanel(t),
      animate: () => this.animatePanel(t), layers: () => this.layersPanel(t), library: () => this.libraryPanel(t) })[id]?.() ?? null;
  }

  // Whether a section has anything to show now (no selection: nothing to arrange).
  sectionAvailable(id) {
    if (id === "arrange") return this.ed.sel.size > 0;
    if (id === "frames") return this.ed.frames().length > 0;
    return true;
  }

  // The panel: a drag edge on its left, a bar (tabs, stack/tabs, fold all, settings), then the
  // sections in the person's order. Its layout is the same in every board pane (panel-store.js).
  sidePanel(t, width) {
    if (!this.panelOnly && popoutId()) return div();
    const st = panelState(), rows = panelSections(st, id => this.sectionAvailable(id));
    const content = this.customize ? [this.panelSettings(t, st)]
      : rows.filter(r => r.active).map(r => this.sectionBlock(t, r, st.mode)).filter(Boolean);
    return h_flex().id("draw-side").w(width).h_full().flex_shrink_0().bg(t.surface ?? t.background)
      .child(div().id("side-edge").w(5).h_full().flex_shrink_0().border_l(1).border_color(this.panelDrag ? t.accent : t.border)
        .cursor_col_resize().hover(s => s.bg(withAlpha(t.accent, 0.25))).tooltip("Drag to resize the panel")
        .on_mouse_down("left", (e, cx) => { this.panelDrag = { x: this.px(e), w: width }; cx.stop_propagation(); cx.notify(); }))
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(this.panelBar(t, st, rows))
        .child(v_flex().id("side-scroll").w_full().flex_1().min_h(0).overflow_y_scroll().children(content)));
  }

  panelBar(t, st, rows) {
    const tabs = st.mode === "tabs" && !this.customize;
    const bar = h_flex().id("side-bar").w_full().flex_shrink_0().gap(4).px(6).py(5).items_center().border_b(1).border_color(t.border);
    if (tabs) bar.child(h_flex().flex_1().min_w(0).flex_wrap().gap(3).children(rows.map(r =>
      this.chip(t, `tab-${r.id}`, r.title, r.active, `Show ${r.title}`, () => changePanel({ type: "tab", id: r.id }), 30))));
    else bar.child(div().flex_1().text_size(10).text_color(t.dim).font_semibold().child(this.customize ? "PANEL SETTINGS" : ""));
    return bar
      .when(!this.customize, b => b
        .child(this.chip(t, "side-mode", tabs ? "☰" : "▭", false, tabs ? "Show every section, one under another" : "Show one section at a time, as tabs",
          () => changePanel({ type: "mode", mode: tabs ? "stack" : "tabs" })))
        .when(!tabs, b => b.child(this.chip(t, "side-fold", rows.some(r => !r.folded) ? "⊟" : "⊞", false, "Fold or unfold every section",
          () => changePanel({ type: "foldAll", folded: rows.some(r => !r.folded) })))))
      .when(!this.panelOnly && !this.customize, b => b.child(this.chip(t, "side-popout", "⧉", false, "Pop the panel out into its own window", () => this.togglePopout())))
      .child(this.chip(t, "side-gear", this.customize ? "done" : "⚙", this.customize, this.customize ? "Back to the panel" : "Panel settings: sections, order, layout",
        () => { this.customize = !this.customize; }, this.customize ? 40 : 26));
  }

  // One section, stacked: a title to fold it (click) or move it (drag onto another title), then its body.
  sectionBlock(t, r, mode) {
    const c = this.sectionContent(t, r.id);
    if (!c) return null;
    const body = div().w_full().px(10).pb(8).pt(mode === "tabs" ? 8 : 0).child(c.body);
    // As a tab, the tab names the section; a title that says more ("Properties · 3 selected") shows above the body.
    if (mode === "tabs") return v_flex().id(`sec-${r.id}`).w_full()
      .when(c.title !== r.title, el => el.child(div().px(10).pt(8).text_size(10).text_color(t.dim).font_semibold().child(c.title.toUpperCase())))
      .child(body);
    const dragging = this.secDrag?.moved && this.secDrag.id === r.id;
    const head = h_flex().id(`sec-head-${r.id}`).w_full().h(26).px(8).gap(5).items_center().cursor_pointer()
      .bg(dragging ? withAlpha(t.accent, 0.16) : CLEAR).hover(s => s.bg(t.hover))
      .tooltip("Click to fold · drag onto another title to move")
      .on_mouse_down("left", (_e, cx) => { this.secDrag = { id: r.id, moved: false }; cx.stop_propagation(); })
      .on_mouse_move((_e, cx) => {
        const d = this.secDrag;
        if (!d || d.id === r.id) return;
        d.moved = true;
        if (changePanel({ type: "moveOnto", id: d.id, target: r.id }, { save: false })) cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.secDrag?.id === r.id && !this.secDrag.moved) { changePanel({ type: "fold", id: r.id }); cx.notify(); }
      })
      .child(div().w(10).text_size(10).text_color(t.dim).child(r.folded ? "▸" : "▾"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).font_semibold().child(c.title.toUpperCase()));
    return v_flex().id(`sec-${r.id}`).w_full().border_b(1).border_color(t.border).child(head).when(!r.folded, el => el.child(body));
  }

  // ⚙: which sections show and in what order, stacked or tabs, width presets, reset.
  panelSettings(t, st) {
    const n = st.order.length;
    const rows = st.order.map((id, i) => h_flex().id(`ps-${id}`).w_full().h(26).gap(4).items_center()
      .child(this.chip(t, `ps-show-${id}`, st.hidden.includes(id) ? "☐" : "☑", false, id === "properties" ? "Properties always shows" : "Show or hide this section",
        () => changePanel({ type: "hide", id })))
      .child(div().flex_1().text_size(12).text_color(st.hidden.includes(id) ? t.dim : t.foreground).child(titleOf(id)))
      .child(this.chip(t, `ps-up-${id}`, "↑", false, "Move up", () => changePanel({ type: "move", id, to: Math.max(0, i - 1) })))
      .child(this.chip(t, `ps-down-${id}`, "↓", false, "Move down", () => changePanel({ type: "move", id, to: Math.min(n - 1, i + 1) }))));
    const label = s => div().text_size(10).text_color(t.dim).font_semibold().mt(6).child(s);
    return v_flex().id("panel-settings").w_full().gap(4).px(10).py(8)
      .child(label("SECTIONS"))
      .children(rows)
      .child(label("LAYOUT"))
      .child(h_flex().gap(4)
        .child(this.chip(t, "ps-stack", "stacked", st.mode === "stack", "Every section, one under another", () => changePanel({ type: "mode", mode: "stack" }), 56))
        .child(this.chip(t, "ps-tabs", "tabs", st.mode === "tabs", "One section at a time", () => changePanel({ type: "mode", mode: "tabs" }), 44)))
      .child(label("WIDTH · or drag the panel's left edge"))
      .child(h_flex().gap(4).children([["narrow", WIDTH.min], ["normal", WIDTH.default], ["wide", 320], ["wider", 420]].map(([lab, w]) =>
        this.chip(t, `ps-w-${lab}`, lab, st.width === w, `${w} px`, () => changePanel({ type: "width", width: w }), 44))))
      .child(div().mt(8).child(this.chip(t, "ps-reset", "reset layout", false, "Default order, width and folds (your colors stay)", () => changePanel({ type: "reset" }), 80)));
  }

  // Panel drags, from the pane's root: the edge follows the pointer; a title drag ends here.
  panelMove(e, cx) {
    const d = this.panelDrag;
    if (!d) return;
    if (changePanel({ type: "width", width: dragWidth(d.w, d.x, this.px(e)) }, { save: false })) cx.notify();
  }
  panelDragEnd(cx) {
    if (!this.panelDrag && !this.secDrag) return;
    this.panelDrag = null; this.secDrag = null;
    savePanel();
    cx.notify();
  }
  // A pointer's x in zoom-1 px, window-relative (the edge moves, so its own coordinates won't do).
  px(e) { return (e.position?.x ?? e.local_position?.x ?? 0) / Z(); }

  // A chip's label with its key after it, small and dim.
  keyed(t, label, key) { return h_flex().gap(3).items_center().child(div().child(label)).child(div().text_size(9).text_color(t.dim).child(this.kk(key))); }

  chip(t, id, label, active, tip, fn, w = 26) {
    return div().id(id).h(24).min_w(w).px(4).rounded(5).flex().items_center().justify_center().text_size(12)
      .border(1).border_color(active ? t.accent : t.border).bg(active ? withAlpha(t.accent, 0.18) : CLEAR)
      .hover(s => s.bg(t.hover)).cursor_pointer().tooltip(this.kk(tip))
      .on_click((_e, cx) => { fn(cx); this.handle.focus(); this.after(cx); }).child(this.kk(label));
  }

  swatch(t, id, color, active, fn) {
    const fill = color === "transparent" ? CLEAR : color === "#1e1e1e" ? t.foreground : color;
    return div().id(id).w(18).h(18).rounded(4).bg(fill).border(active ? 2 : 1).border_color(active ? t.accent : t.border)
      .flex().items_center().justify_center().text_size(11).text_color(t.dim).cursor_pointer()
      .on_click((_e, cx) => { fn(); this.handle.focus(); this.after(cx); })
      .when(color === "transparent", e => e.child("∅"));
  }

  // ── colors: the Stroke and Fill rows, and the picker under one of them ──
  // What colorRow / pickerModel (core/color.js) say to show; this only draws and wires clicks.
  colorKey(kind) { return kind === "fill" ? "backgroundColor" : "strokeColor"; }
  currentColor(kind) { const ed = this.ed, k = this.colorKey(kind); return (ed.selected()[0] ?? ed.style)[k] ?? ed.style[k]; }
  // A picked color (grid, hex, recent, saved, none): style the selection, or the next shape, and remember it.
  applyColor(kind, color) {
    if (!kind) return;
    this.ed.setStyle({ [this.colorKey(kind)]: color });
    changePanel({ type: "used", color });
    this.hexInput.set_value(color === "transparent" ? "" : color); this.hexMsg = null;
    this.hexFocused = false;   // every apply hands the keyboard back to the board (no blur may come)
  }
  toggleColorPick(kind) {
    if (this.colorPick === kind) return this.closeColorPick();
    this.colorPick = kind; this.hexMsg = null; this.hexFocused = false;
    const c = this.currentColor(kind);
    this.hexInput.set_value(c && c !== "transparent" ? c : "");
  }
  closeColorPick() { this.colorPick = null; this.hexMsg = null; this.hexFocused = false; }

  colorSwatches(t, kind) {
    const pre = kind === "fill" ? "fi" : "st", fixed = kind === "fill" ? FILLS : STROKES, open = this.colorPick === kind;
    const r = colorRow(fixed, panelState().palette[kind], this.currentColor(kind)), set = c => () => this.ed.setStyle({ [this.colorKey(kind)]: c });
    return [
      ...r.fixed.map((c, i) => this.swatch(t, `${pre}-${i}`, c.color, c.active, set(c.color))),
      ...r.saved.map((c, i) => this.swatch(t, `${pre}-own-${i}`, c.color, c.active, set(c.color))),
      r.custom && this.swatch(t, `${pre}-cur`, r.custom, true, () => {}),
      this.chip(t, `${pre}-pick`, open ? "−" : "+", open, open ? "Close the color picker" : "Any color: a grid, a hex code, your saved and recent colors",
        () => this.toggleColorPick(kind), 22),
    ].filter(Boolean);
  }

  colorPicker(t, kind) {
    const st = panelState(), m = pickerModel({ kind, fixed: kind === "fill" ? FILLS : STROKES, saved: st.palette[kind], recent: st.recent, current: this.currentColor(kind) });
    const apply = c => () => this.applyColor(kind, c);
    const label = s => div().text_size(9).text_color(t.dim).font_semibold().child(s);
    // 5 × 13 cells that share the width (so the grid fits a 180 px panel), fixed height.
    const cell = (c, id) => div().id(id).flex_1().min_w(0).h(14).bg(c.color).cursor_pointer()
      .when(c.active, e => e.border(2).border_color(inkOn(c.color)))
      .on_click((_e, cx) => { this.applyColor(kind, c.color); this.handle.focus(); this.after(cx); });
    const grid = v_flex().id("cp-grid").w_full().gap(1).rounded(4).overflow_hidden()
      .children(m.grid.map((row, r) => h_flex().w_full().gap(1).children(row.map((c, i) => cell(c, `cp-g-${r}-${i}`)))));
    const field = h_flex().w_full().gap(4).items_center()
      .child(div().id("cp-hex").flex_1().min_w(0).child(Input.new(this.hexInput).h(24).text_size(12)))
      .child(this.chip(t, "cp-save", "save", false, m.canSave ? `Keep this color in the ${kind === "fill" ? "Fill" : "Stroke"} row` : "Already in the row",
        () => { if (m.canSave) changePanel({ type: "addColor", kind, color: this.currentColor(kind) }); }, 36))
      .when(!!m.none, e => e.child(this.chip(t, "cp-none", "none", m.none.active, "No fill", apply("transparent"), 36)));
    const saved = m.saved.map((c, i) => h_flex().gap(1).items_center()
      .child(this.swatch(t, `cp-s-${i}`, c.color, c.active, apply(c.color)))
      .child(div().id(`cp-x-${i}`).w(12).h(18).flex().items_center().justify_center().text_size(9).text_color(t.dim).cursor_pointer()
        .hover(s => s.text_color(t.foreground)).tooltip("Remove from the row")
        .on_click((_e, cx) => { changePanel({ type: "removeColor", kind, color: c.color }); this.handle.focus(); this.after(cx); }).child("✕")));
    return v_flex().id(`cp-${kind}`).w_full().gap(6).p(6).rounded(6).border(1).border_color(t.border)
      .child(grid)
      .child(field)
      .when(!!this.hexMsg, e => e.child(div().id("cp-msg").text_size(10).text_color(t.blocked ?? t.dim).child(this.hexMsg)))
      .when(m.recent.length > 0, e => e.child(label("RECENT")).child(h_flex().w_full().flex_wrap().gap(4)
        .children(m.recent.map((c, i) => this.swatch(t, `cp-r-${i}`, c.color, c.active, apply(c.color))))))
      .when(saved.length > 0, e => e.child(label("SAVED")).child(h_flex().w_full().flex_wrap().gap(4).children(saved)));
  }

  properties(t) {
    const ed = this.ed, cur = ed.selected()[0] ?? ed.style, s = k => cur[k] ?? ed.style[k];
    // A row's label carries its key (C, B, W…): the panels teach the keys as they are used.
    const row = (label, kids, key) => h_flex().w_full().items_center().gap(4)
      .child(h_flex().w(44).flex_shrink_0().gap(3).items_center().child(div().text_size(11).text_color(t.muted).child(label)).when(!!key, e => e.child(div().text_size(9).text_color(t.dim).child(key))))
      .child(h_flex().flex_1().flex_wrap().gap(4).children(kids));
    const body = v_flex().gap(6)
      .child(row("Stroke", this.colorSwatches(t, "stroke"), "C"))
      .when(this.colorPick === "stroke", e => e.child(this.colorPicker(t, "stroke")))
      .child(row("Fill", this.colorSwatches(t, "fill"), "B"))
      .when(this.colorPick === "fill", e => e.child(this.colorPicker(t, "fill")))
      .child(row("Width", WIDTHS.map((w, i) => this.chip(t, `w-${w}`, ["thin", "bold", "extra"][i], s("strokeWidth") === w, `Stroke ${w}px (W)`, () => ed.setStyle({ strokeWidth: w }), 40)), "W"))
      .child(row("Style", STYLES.map(v => this.chip(t, `ss-${v}`, { solid: "—", dashed: "- -", dotted: "···" }[v], s("strokeStyle") === v, `${v} (S)`, () => ed.setStyle({ strokeStyle: v }))), "S"))
      .child(row("Sketch", [0, 1, 2].map(r => this.chip(t, `ro-${r}`, ["clean", "sketch", "loose"][r], s("roughness") === r, "Roughness (G toggles)", () => ed.setStyle({ roughness: r }), 44)), "G"))
      .child(row("Opacity", [100, 75, 50, 25].map(o => this.chip(t, `op-${o}`, `${o}`, s("opacity") === o, `Opacity ${o}%`, () => ed.setStyle({ opacity: o })))))
      .child(row("Fill", ["solid", "hachure", "cross-hatch"].map(f => this.chip(t, `fs2-${f}`, { solid: "solid", hachure: "////", "cross-hatch": "xxxx" }[f], (s("fillStyle") ?? "solid") === f, `Fill style: ${f}`, () => ed.setStyle({ fillStyle: f }), 40))))
      .child(row("Edges", [["sharp", null], ["round", { type: 3 }]].map(([lab, v]) => this.chip(t, `rd-${lab}`, lab, !!s("roundness") === !!v, `${lab} corners / curves`, () => ed.setStyle({ roundness: v }), 44))))
      .child(row("Font", Object.keys(FONT_FAMILY).map(f => this.chip(t, `ff-${f}`, f, (ed.selected()[0] && (ed.selected()[0].type === "text" ? ed.selected()[0].fontFamily : ed.doc.labelOf(ed.selected()[0])?.fontFamily) || ed.style.fontFamily) === FONT_FAMILY[f], `Font: ${f}`, () => ed.setStyle({ fontFamily: FONT_FAMILY[f] }), 40))))
      .child(row("Text", [16, 20, 28, 36].map(f => this.chip(t, `fs-${f}`, `${f}`, (ed.selectedFont() ?? ed.style.fontSize) === f, `Font size ${f} (= and -)`, () => ed.setStyle({ fontSize: f }))), "= -"));
    const lineSel = ed.selected().find(e => e.type === "arrow" || e.type === "line");
    if (lineSel || ed.tool === "arrow" || ed.tool === "line") {
      // Three ways to run a line: straight stretches, a smooth curve through its points, or right angles routed around shapes.
      const kind = a => (a?.elbowed ? "elbow" : a?.roundness ? "curve" : "sharp"), cur = lineSel ? kind(lineSel) : kind(ed.style);
      const isArrow = lineSel ? lineSel.type === "arrow" : ed.tool === "arrow";
      const types = [["sharp", { elbowed: false, roundness: null }, "Straight stretches, sharp corners at bends"], ["curve", { elbowed: false, roundness: { type: 2 } }, "A smooth curve through its points (a straight one gets an arc)"], ["elbow", { elbowed: true, roundness: null }, "Right angles, routed around shapes"]]
        .filter(([lab]) => isArrow || lab !== "elbow");
      body.child(row(isArrow ? "Arrow" : "Line", types.map(([lab, patch, tip]) =>
        this.chip(t, `at-${lab}`, { sharp: "╱", curve: "◠", elbow: "┐" }[lab] + " " + lab, cur === lab, tip, () => ed.setStyle(patch), 50))));
      if (lineSel && !lineSel.elbowed) body.child(row("Bends", [
        this.chip(t, "bend-add", "+ bend", false, "Bend it in the middle (or drag a ○ on it, anywhere)", () => ed.addBend(), 50),
        this.chip(t, "bend-none", "straighten", false, "Remove every bend (double-click one to remove just it)", () => ed.straighten(), 66)]));
    }
    if (ed.selected().some(e => e.type === "arrow" || e.type === "line")) {
      body.child(row("Heads", [["none", null, null], ["→", null, "arrow"], ["↔", "arrow", "arrow"], ["▶", null, "triangle"], ["▷", null, "triangle_outline"], ["●", null, "dot"], ["◆", null, "diamond"], ["⊣", null, "bar"]].map(([lab, a, b], i) =>
        this.chip(t, `ah-${i}`, lab, (s("startArrowhead") ?? null) === a && (s("endArrowhead") ?? null) === b, `Arrowheads: ${b ?? "none"}`, () => ed.setStyle({ startArrowhead: a, endArrowhead: b }), 26))));
    }
    return this.section(t, ed.sel.size ? `Properties · ${ed.sel.size} selected` : "Properties · next shape", body);
  }

  arrange(t) {
    const ed = this.ed;
    if (!ed.sel.size) return null;
    const body = v_flex().gap(6)
      .child(h_flex().flex_wrap().gap(4).children(ALIGN.map(([how, icon, key]) => this.chip(t, `al-${how}`, this.keyed(t, icon, key), false, `Align ${how} (${key})`, () => ed.align(how)))))
      .child(h_flex().flex_wrap().gap(4)
        .child(this.chip(t, "dh", this.keyed(t, "⇹", "⇧H"), false, "Distribute horizontally (⇧H)", () => ed.distribute("h")))
        .child(this.chip(t, "dv", this.keyed(t, "⇳", "⇧V"), false, "Distribute vertically (⇧V)", () => ed.distribute("v")))
        .child(this.chip(t, "zf", this.keyed(t, "⤒", "⌘]"), false, "Bring to front (⌘])", () => ed.reorder("front")))
        .child(this.chip(t, "zu", this.keyed(t, "↑", "]"), false, "Bring forward (])", () => ed.reorder("forward")))
        .child(this.chip(t, "zd", this.keyed(t, "↓", "["), false, "Send backward ([)", () => ed.reorder("backward")))
        .child(this.chip(t, "zb", this.keyed(t, "⤓", "⌘["), false, "Send to back (⌘[)", () => ed.reorder("back"))))
      .child(h_flex().flex_wrap().gap(4)
        .child(this.chip(t, "grp", this.keyed(t, "group", "⌘G"), false, "Group (⌘G)", () => ed.group(), 44))
        .child(this.chip(t, "ugrp", this.keyed(t, "ungroup", "⌘⇧G"), false, "Ungroup (⌘⇧G)", () => ed.ungroup(), 54))
        .child(this.chip(t, "dup", this.keyed(t, "dup", "⌘D"), false, "Duplicate (⌘D)", () => ed.cloneSelection(20, 20), 34))
        .child(this.chip(t, "lk", this.keyed(t, "lock", "⌘⇧L"), ed.selected().some(e => e.locked), "Lock (⌘⇧L)", () => ed.toggleLock(), 36)))
      .child(h_flex().flex_wrap().gap(4)
        .child(this.chip(t, "rl", this.keyed(t, "⟲ 15°", "<"), false, "Rotate left 15° (<)", () => ed.rotateBy(-15), 44))
        .child(this.chip(t, "rr", this.keyed(t, "⟳ 15°", ">"), false, "Rotate right 15° (>)", () => ed.rotateBy(15), 44))
        .child(this.chip(t, "r90", "⟳ 90°", false, "Rotate 90°", () => ed.rotateBy(90), 44))
        .child(this.chip(t, "r0", "0°", false, "Reset rotation", () => ed.resetRotation(), 30)));
    return this.section(t, "Arrange", body);
  }

  // Frames as pages: each frame in reading order; a click shows it, PgDn/PgUp step through them.
  framesPanel(t) {
    const ed = this.ed, fs = ed.frames();
    if (!fs.length) return null;
    const rows = fs.map((f, i) => h_flex().id(`fr-${f.id}`).w_full().h(26).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .bg(ed.frameAt === f.id ? withAlpha(t.accent, 0.16) : CLEAR).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { ed.goToFrame(f.id); this.handle.focus(); this.after(cx); })
      .child(div().w(16).text_size(10).text_color(t.dim).child(String(i + 1)))
      .child(div().flex_1().truncate().text_size(12).child(f.name || "Frame")));
    const body = v_flex().gap(2).children(rows)
      .child(h_flex().gap(4).mt(4)
        .child(this.chip(t, "fr-prev", this.keyed(t, "‹ prev", "PgUp"), false, "Previous frame (PgUp)", () => ed.stepFrame(-1), 60))
        .child(this.chip(t, "fr-next", this.keyed(t, "next ›", "PgDn"), false, "Next frame (PgDn)", () => ed.stepFrame(1), 60))
        .child(this.chip(t, "fr-all", "all", false, "Fit everything (⇧1)", () => ed.fit(), 34)));
    return this.section(t, `Frames · ${fs.length}`, body);
  }

  animatePanel(t) {
    const ed = this.ed, n = ed.sel.size, anim = ed.selected()[0]?.customData?.anim?.preset;
    const body = v_flex().gap(6)
      .child(h_flex().flex_wrap().gap(4).children(PRESET_NAMES.map(p => this.chip(t, `an-${p}`, p, anim === p, n ? `Animate the selection: ${p}` : "Select something to animate", () => { if (n) ed.animate(p); }, 40))))
      .child(h_flex().gap(4)
        .child(this.chip(t, "an-clear", "none", false, "Remove the selection's animation", () => ed.clearAnimation(), 40))
        .child(this.chip(t, "an-play", this.keyed(t, ed.play ? "❚❚ pause" : "▶ play", "⇧Space"), !!ed.play, "Play the timeline (⇧Space)", () => ed.playToggle(), 64)));
    return this.section(t, "Animate", body);
  }

  layersPanel(t) {
    const ed = this.ed, layers = [...ed.doc.layers].reverse();   // top first, as in Photoshop
    const counts = new Map(); for (const e of ed.doc.live()) if (!isLabel(e)) counts.set(layerOf(e), (counts.get(layerOf(e)) ?? 0) + 1);
    const rows = layers.map(l => h_flex().id(`ly-${l.id}`).w_full().h(28).px(4).gap(4).items_center().rounded(5)
      .bg(ed.activeLayer === l.id ? withAlpha(t.accent, 0.16) : CLEAR).hover(s => s.bg(t.hover)).cursor_pointer()
      .on_click((e, cx) => {
        if ((e.click_count ?? 1) >= 2) { this.renaming = l.id; this.layerInput.set_value(l.name); cx.timer.after(30, () => this.layerInput.focus()); }
        else { ed.activeLayer = l.id; ed.changed(); }
        this.after(cx);
      })
      .child(this.chip(t, `lv-${l.id}`, l.visible ? "◉" : "○", false, l.visible ? "Hide layer" : "Show layer", () => ed.updateLayer(l.id, { visible: !l.visible }), 22))
      .child(this.chip(t, `ll-${l.id}`, l.locked ? "🔒" : "·", l.locked, l.locked ? "Unlock layer" : "Lock layer", () => ed.updateLayer(l.id, { locked: !l.locked }), 22))
      .child(this.renaming === l.id
        ? div().flex_1().child(Input.new(this.layerInput).h(22).text_size(12))
        : div().flex_1().truncate().text_size(12).text_color(l.visible ? t.foreground : t.dim).child(l.name))
      .when(l.opacity < 100, e => e.child(div().text_size(10).text_color(t.dim).child(`${l.opacity}%`)))
      .child(div().text_size(10).text_color(t.dim).child(String(counts.get(l.id) ?? 0))));
    const al = ed.activeLayer;
    const body = v_flex().gap(2).children(rows)
      .child(h_flex().gap(4).mt(4)
        .child(this.chip(t, "ly-add", "+", false, "New layer", () => ed.addLayer()))
        .child(this.chip(t, "ly-up", "↑", false, "Move layer up", () => ed.moveLayer(al, 1)))
        .child(this.chip(t, "ly-dn", "↓", false, "Move layer down", () => ed.moveLayer(al, -1)))
        .child(this.chip(t, "ly-op", "◐", false, "Layer opacity", () => { const l = ed.doc.layer(al); ed.updateLayer(al, { opacity: { 100: 75, 75: 50, 50: 25 }[l.opacity] ?? 100 }); }))
        .child(this.chip(t, "ly-to", "⇢", false, "Move the selection to this layer", () => ed.moveToLayer(al)))
        .child(this.chip(t, "ly-del", "✕", false, "Delete layer (its elements move down one)", () => ed.deleteLayer(al))));
    return this.section(t, "Layers · double-click to rename", body);
  }

  timeline(t) {
    const ed = this.ed, dur = ed.duration(), now = ed.time();
    const frac = now == null ? 0 : Math.max(0, Math.min(1, now / dur));
    const trackW = Math.max(40, this.size.w + this.sideW - 230);
    return h_flex().id("draw-timeline").w_full().h(34).px(10).gap(10).items_center().border_t(1).border_color(t.border).bg(t.surface ?? t.background).flex_shrink_0()
      .child(this.chip(t, "tl-play", ed.play ? "❚❚" : "▶", !!ed.play, "Play / pause (⇧space)", () => ed.playToggle()))
      .child(this.chip(t, "tl-stop", "■", false, "Back to editing (esc)", () => ed.stopPlay()))
      .child(div().id("tl-track").w(trackW).h(18).relative().cursor_pointer()
        .on_mouse_down("left", (e, cx) => { if (!e.local_position || !e.bounds) return; ed.play = null; ed.scrub = dur * Math.max(0, Math.min(1, e.local_position.x / e.bounds.width)); ed.changed(); this.after(cx); })
        .child(div().absolute().left(0).top(8).w_full().h(2).rounded(1).bg(t.border))
        .child(div().absolute().left(0).top(8).h(2).rounded(1).bg(t.accent).w(trackW * frac))
        .children(ed.doc.live().filter(e => e.customData?.anim?.start != null && !isLabel(e)).map(e => div().absolute().top(4).w(2).h(10).bg(t.dim).left(trackW * Math.min(1, e.customData.anim.start / dur)))))
      .child(div().text_size(11).text_color(t.dim).child(`${((now ?? 0) / 1000).toFixed(1)}s / ${(dur / 1000).toFixed(1)}s`));
  }
}
