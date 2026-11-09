// herdr-draw — the Herdr adapter. Thin on purpose: it turns GPUI events into
// editor calls and the editor's display list into GPUI elements. All behavior
// lives in ./core (tested headless with `bun test`).
//
// Open: pane.split {mod: "herdr-draw", props: {file}}. Agents use `drawh`.

import { View, div, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, exec, theme, settings, home, appHome, nextCommand, panes, readTextFile, writeTextFile, fonts } from "herdr";
import { Editor, TOOLS, STROKES, FILLS, WIDTHS, STYLES } from "./core/editor.js";
import { withAlpha } from "./core/render.js";
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

const MOD = "herdr-draw";
const Z = () => Number(settings().zoom) || 1;
const CACHE = () => `${home()}/.cache/herdr-draw`;
const SIDEBAR = 232;
const ALIGN = [["left", "⇤"], ["hcenter", "↔"], ["right", "⇥"], ["top", "⤒"], ["vcenter", "↕"], ["bottom", "⤓"]];
const CLEAR = "#00000000";
// image() loads only paths under the app home (~/.config/herdr-app or $HERDR_APP_HOME), so
// board images are decoded into a hidden cache there: outside the mod folder (no hot reload,
// and a dev sync's rsync --delete doesn't wipe it).
const IMG_REL = ".cache/herdr-draw/img";
const IMG_DIR = () => `${appHome()}/${IMG_REL}`;
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
function batchPaths(items) {
  const layers = [], texts = [];
  let cur = null;
  for (const it of items) {
    if (it.t === "text") { cur = null; texts.push(it); continue; }
    if (it.t === "image") { cur = null; layers.push({ img: it, n: 1 }); continue; }
    const color = withAlpha(it.fill ?? it.stroke, it.opacity ?? 1);
    const key = it.fill ? `f|${color}` : `s|${color}|${it.width}|${it.dash?.join(",") ?? ""}`;
    if (!cur || cur.key !== key) {
      let b = it.fill ? PathBuilder.fill() : PathBuilder.stroke(it.width);
      if (it.dash) b = b.dash_array(it.dash);
      cur = { key, color, b, n: 0 }; layers.push(cur);
    }
    let started = false;
    for (const c of it.cmds) {
      if (c[0] === "M" && it.fill && started) cur.b.close();   // each filled shape closes before the next starts
      started = true;
      if (c[0] === "M") cur.b.move_to(c[1], c[2]);
      else if (c[0] === "L") cur.b.line_to(c[1], c[2]);
      else if (c[0] === "Q") cur.b.curve_to(c[1], c[2], c[3], c[4]);
    }
    if (it.fill) cur.b.close();
    cur.n++;
  }
  return { layers, texts };
}

export default class Draw extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file ? String(p.file).replace(/^~(?=\/)/, home()) : null;
    // Ops only mark the board dirty; after(cx) schedules the save with the live event's cx
    // (a cx kept past its call is rejected by GPUI).
    this.ed = new Editor({ onOp: op => { if (!op.transient) this.dirty = true; } });
    this.error = this.file ? null : "No file: open with props {file}";
    this.flash = null; this.sidebar = p.sidebar ?? true; this.selKey = "";
    this.tick = null; this.size = { w: 900, h: 600 }; this.measured = false;   // a default size so panels render before layout this.textOpen = false; this.renaming = null;
    this.handle = cx.focus_handle();
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
    this.layerInput = InputState.new({ value: "", placeholder: "Layer name" });
    this.layerInput.on("submit", (_e, cx) => { if (this.renaming) this.ed.updateLayer(this.renaming, { name: this.layerInput.value() || "Layer" }); this.renaming = null; this.handle.focus(); this.after(cx); });
    this.lib = new LibraryStore({ onChange: () => { this.previews.clear(); }, onError: m => { this.flash = m; } });
    this.previews = new Map();   // library item id → its preview's path layers
    cx.spawn(async acx => { await this.lib.start(acx); });
    if (this.file) {
      this.store = new FileStore(this.file, this.ed, {
        onError: m => { this.error = m; },
        onExternal: n => { this.error = null; this.flash = `${n} change${n === 1 ? "" : "s"} from the file`; },
      });
      cx.spawn(async acx => { await this.store.start(acx); this.fitted = false; this.maybeFit(); acx.notify(); });
    }
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "fit") this.ed.fit();
        else if (c === "play") this.ed.playToggle();
        else if (c === "export") { if (this.file) await this.exportBoard(); }
        else if (c === "write") this.ed.beginText(null, this.ed.toWorld({ x: this.size.w / 3, y: this.size.h / 3 }));   // start typing (no mouse needed)
        else if (c === "focus") { cx.timer.after(60, () => { if (panes().find(q => q.focused)?.mod === MOD) this.handle.focus(); }); continue; }
        this.after(cx);
      }
    });
  }

  // On open, show the drawing at 100% (centered) unless it's too big, then zoom out to fit.
  maybeFit() { if (!this.fitted && this.measured && this.ed.doc.live().length) { this.fitted = true; this.ed.fit(); } }

  // After every event: keep the text box, timer and agent selection file in step.
  after(cx) {
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
    if (key !== this.selKey && !ed.g) { this.selKey = key; this.writeSelection(); }
    if (this.dirty && this.store) { this.dirty = false; this.store.schedule(cx); }
    if (!ed.g) this.store?.flushPending(cx);
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
    if (this.ed.text && !this.inputFocused) { if (this.typeFallback(e, cx)) cx.stop_propagation(); return; }
    if (this.ed.text && (e.key === "escape" || (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)))) { this.ed.setText(this.input.value()); this.ed.commitText(); cx.stop_propagation(); return this.after(cx); }
    const ed = this.ed, m = e.modifiers ?? {}, mm = { shift: m.shift, alt: m.alt, cmd: m.platform, ctrl: m.control };
    if (!ed.text && m.platform && (e.key === "c" || e.key === "x")) {
      // The system clipboard gets Excalidraw's format, so paste works in excalidraw.com too.
      const text = ed.copy();
      if (text) { exec("sh", ["-c", 'printf %s "$1" | LANG=en_US.UTF-8 pbcopy', "copy", text]); if (e.key === "x") ed.deleteIds([...ed.sel]); this.flash = "copied"; }
      cx.stop_propagation(); return this.after(cx);
    }
    if (!ed.text && m.platform && e.key === "v") {
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
    if (!ed.text && m.platform && m.shift && e.key === "e") { cx.spawn(async cx => { await this.exportBoard(); cx.notify(); }); cx.stop_propagation(); return this.after(cx); }
    if (!ed.text && !m.platform && !m.control && e.key === "i") { this.sidebar = !this.sidebar; cx.stop_propagation(); return this.after(cx); }
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
    const doc = this.ed.doc, theme = boardTheme(doc.appState), base = this.file.replace(/\.excalidraw(\.json)?$/, "");
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
    const t = theme();
    this.ensureImages(cx);
    const showSide = this.sidebar && this.size.w > 360;
    return v_flex().id("draw").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.keys(e, cx))
      .child(this.toolbar(t))
      .child(h_flex().flex_1().min_h(0).w_full()
        .child(this.canvas(t))
        .when(showSide, el => el.child(this.sidePanel(t))))
      .when(this.ed.duration() > 1 || !!this.ed.play, el => el.child(this.timeline(t)));
  }

  button(t, id, label, active, tip, fn) {
    return div().id(id).h(26).min_w(26).px(5).rounded(6).flex().items_center().justify_center().gap(3)
      .bg(active ? t.accent : CLEAR).text_color(active ? t.accent_foreground : t.foreground)
      .hover(s => s.bg(active ? t.accent : t.hover)).cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => { fn(); this.handle.focus(); this.after(cx); }).child(label);
  }

  toolbar(t) {
    const ed = this.ed, name = (this.file ?? "").split("/").pop();
    const status = this.error ?? this.flash ?? ed.flash ?? `${ed.doc.visible().filter(e => !isLabel(e)).length} elements`;
    return h_flex().id("draw-bar").w_full().h(36).px(6).gap(1).items_center().border_b(1).border_color(t.border).bg(t.surface ?? t.background).flex_shrink_0()
      .children(TOOLS.map(tool => this.button(t, `tool-${tool.id}`, div().text_size(14).child(tool.icon), ed.tool === tool.id, `${tool.name} (${tool.keys.join(" / ")})`, () => ed.setTool(tool.id))))
      .child(div().w(1).h(18).mx(4).bg(t.border))
      .child(this.button(t, "lock", div().text_size(12).child(ed.toolLock ? "🔒" : "🔓"), ed.toolLock, "Keep the tool after drawing (q)", () => ed.key("q")))
      .child(this.button(t, "undo", div().text_size(14).child("↶"), false, "Undo (⌘Z)", () => ed.undo()))
      .child(this.button(t, "redo", div().text_size(14).child("↷"), false, "Redo (⌘⇧Z)", () => ed.redo()))
      .child(this.button(t, "grid", div().text_size(13).child("▦"), !!ed.grid, "Snap to grid (⌘')", () => ed.key("'", { cmd: true })))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(this.error ? t.blocked : t.dim).truncate().child(status))
      .child(div().w(8))
      .child(this.button(t, "zoom", div().text_size(11).text_color(t.muted).child(`${Math.round(ed.view.scale * 100)}%`), false, "Fit everything (⇧1)", () => ed.fit()))
      .child(this.button(t, "side", div().text_size(13).child("◧"), this.sidebar, "Properties and layers (i)", () => { this.sidebar = !this.sidebar; }))
      .child(div().ml(4).text_size(12).text_color(t.muted).truncate().child(name));
  }

  canvas(t) {
    const { layers, texts } = batchPaths(this.ed.displayList(this.palette()));
    const tool = this.ed.tool;
    let el = div().id("draw-canvas").flex_1().min_w(0).h_full().relative().overflow_hidden();
    if (tool === "hand") el = el.cursor_grab(); else if (tool !== "select") el = el.cursor_crosshair();
    return this.canvasEvents(el)
      .children(layers.filter(l => l.n).map(l => l.img ? this.imageItem(l.img, t) : div().absolute().top(0).left(0).size_full().child(window.paint_path(l.b.build(), l.color))))
      .children(texts.map(it => this.textItem(it, t)))
      .when(!this.ed.doc.live().length && !this.error, e => e.child(this.emptyHint(t)))
      .when(!!this.ed.text, e => e.child(this.textInput(t)));
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

  textItem(it, t) {
    let text = String(it.text ?? "");
    if (it.reveal != null && it.reveal < 1) text = text.slice(0, Math.round(text.length * it.reveal));   // typewriter
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
        .child(div().child("double-click to write · drag empty space to select · ⌘Z undo · i panels"))
        .child(div().child("drop or paste an image to put it on the board"))
        .child(div().child("agents: drawh add / arrow / ls / sel")));
  }

  // ── panels ─────────────────────────────────────────────────────────────

  section(t, title, body) {
    return v_flex().w_full().gap(6).px(10).py(8).border_b(1).border_color(t.border)
      .child(div().text_size(10).text_color(t.dim).font_semibold().child(title.toUpperCase()))
      .child(body);
  }

  sidePanel(t) {
    return v_flex().id("draw-side").w(SIDEBAR).h_full().flex_shrink_0().border_l(1).border_color(t.border).bg(t.surface ?? t.background).overflow_y_scroll()
      .child(this.properties(t))
      .child(this.arrange(t))
      .child(this.animatePanel(t))
      .child(this.layersPanel(t))
      .child(this.libraryPanel(t));
  }

  chip(t, id, label, active, tip, fn, w = 26) {
    return div().id(id).h(24).min_w(w).px(4).rounded(5).flex().items_center().justify_center().text_size(12)
      .border(1).border_color(active ? t.accent : t.border).bg(active ? withAlpha(t.accent, 0.18) : CLEAR)
      .hover(s => s.bg(t.hover)).cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => { fn(cx); this.handle.focus(); this.after(cx); }).child(label);
  }

  swatch(t, id, color, active, fn) {
    const fill = color === "transparent" ? CLEAR : color === "#1e1e1e" ? t.foreground : color;
    return div().id(id).w(18).h(18).rounded(4).bg(fill).border(active ? 2 : 1).border_color(active ? t.accent : t.border)
      .flex().items_center().justify_center().text_size(11).text_color(t.dim).cursor_pointer()
      .on_click((_e, cx) => { fn(); this.handle.focus(); this.after(cx); })
      .when(color === "transparent", e => e.child("∅"));
  }

  properties(t) {
    const ed = this.ed, cur = ed.selected()[0] ?? ed.style, s = k => cur[k] ?? ed.style[k];
    const row = (label, kids) => h_flex().w_full().items_center().gap(4).child(div().w(44).flex_shrink_0().text_size(11).text_color(t.muted).child(label)).child(h_flex().flex_1().flex_wrap().gap(4).children(kids));
    const body = v_flex().gap(6)
      .child(row("Stroke", STROKES.map((c, i) => this.swatch(t, `st-${i}`, c, s("strokeColor") === c, () => ed.setStyle({ strokeColor: c })))))
      .child(row("Fill", FILLS.map((c, i) => this.swatch(t, `fi-${i}`, c, s("backgroundColor") === c, () => ed.setStyle({ backgroundColor: c })))))
      .child(row("Width", WIDTHS.map((w, i) => this.chip(t, `w-${w}`, ["thin", "bold", "extra"][i], s("strokeWidth") === w, `Stroke ${w}px (w)`, () => ed.setStyle({ strokeWidth: w }), 40))))
      .child(row("Style", STYLES.map(v => this.chip(t, `ss-${v}`, { solid: "—", dashed: "- -", dotted: "···" }[v], s("strokeStyle") === v, `${v} (s)`, () => ed.setStyle({ strokeStyle: v })))))
      .child(row("Sketch", [0, 1, 2].map(r => this.chip(t, `ro-${r}`, ["clean", "sketch", "loose"][r], s("roughness") === r, "Roughness (g toggles)", () => ed.setStyle({ roughness: r }), 44))))
      .child(row("Opacity", [100, 75, 50, 25].map(o => this.chip(t, `op-${o}`, `${o}`, s("opacity") === o, `Opacity ${o}%`, () => ed.setStyle({ opacity: o })))))
      .child(row("Fill", ["solid", "hachure", "cross-hatch"].map(f => this.chip(t, `fs2-${f}`, { solid: "solid", hachure: "////", "cross-hatch": "xxxx" }[f], (s("fillStyle") ?? "solid") === f, `Fill style: ${f}`, () => ed.setStyle({ fillStyle: f }), 40))))
      .child(row("Edges", [["sharp", null], ["round", { type: 3 }]].map(([lab, v]) => this.chip(t, `rd-${lab}`, lab, !!s("roundness") === !!v, `${lab} corners / curves`, () => ed.setStyle({ roundness: v }), 44))))
      .child(row("Font", Object.keys(FONT_FAMILY).map(f => this.chip(t, `ff-${f}`, f, (ed.selected()[0] && (ed.selected()[0].type === "text" ? ed.selected()[0].fontFamily : ed.doc.labelOf(ed.selected()[0])?.fontFamily) || ed.style.fontFamily) === FONT_FAMILY[f], `Font: ${f}`, () => ed.setStyle({ fontFamily: FONT_FAMILY[f] }), 40))))
      .child(row("Text", [16, 20, 28, 36].map(f => this.chip(t, `fs-${f}`, `${f}`, (ed.selectedFont() ?? ed.style.fontSize) === f, `Font size ${f} (= and -)`, () => ed.setStyle({ fontSize: f })))));
    const arrowSel = ed.selected().find(e => e.type === "arrow");
    if (arrowSel || ed.tool === "arrow") {
      const kind = a => (a?.elbowed ? "elbow" : a?.roundness ? "curve" : "sharp"), cur = arrowSel ? kind(arrowSel) : kind(ed.style);
      body.child(row("Arrow", [["sharp", { elbowed: false, roundness: null }], ["curve", { elbowed: false, roundness: { type: 2 } }], ["elbow", { elbowed: true, roundness: null }]].map(([lab, patch]) =>
        this.chip(t, `at-${lab}`, { sharp: "╱", curve: "◠", elbow: "┐" }[lab] + " " + lab, cur === lab, `Arrow type: ${lab}`, () => ed.setStyle(patch), 50))));
    }
    if (ed.selected().some(e => e.type === "arrow" || e.type === "line")) {
      body.child(row("Heads", [["none", null, null], ["→", null, "arrow"], ["↔", "arrow", "arrow"], ["▶", null, "triangle"], ["▷", null, "triangle_outline"], ["●", null, "dot"], ["◆", null, "diamond"], ["⊣", null, "bar"]].map(([lab, a, b], i) =>
        this.chip(t, `ah-${i}`, lab, (s("startArrowhead") ?? null) === a && (s("endArrowhead") ?? null) === b, `Arrowheads: ${b ?? "none"}`, () => ed.setStyle({ startArrowhead: a, endArrowhead: b }), 26))));
    }
    return this.section(t, ed.sel.size ? `Properties · ${ed.sel.size} selected` : "Properties · next shape", body);
  }

  arrange(t) {
    const ed = this.ed;
    if (!ed.sel.size) return div();
    const body = v_flex().gap(6)
      .child(h_flex().gap(4).children(ALIGN.map(([how, icon]) => this.chip(t, `al-${how}`, icon, false, `Align ${how} (⌥ A D W S H V)`, () => ed.align(how)))))
      .child(h_flex().gap(4)
        .child(this.chip(t, "dh", "⇹", false, "Distribute horizontally (⇧H)", () => ed.distribute("h")))
        .child(this.chip(t, "dv", "⇳", false, "Distribute vertically (⇧V)", () => ed.distribute("v")))
        .child(this.chip(t, "zf", "⤒", false, "Bring to front (⌘])", () => ed.reorder("front")))
        .child(this.chip(t, "zu", "↑", false, "Bring forward (])", () => ed.reorder("forward")))
        .child(this.chip(t, "zd", "↓", false, "Send backward ([)", () => ed.reorder("backward")))
        .child(this.chip(t, "zb", "⤓", false, "Send to back (⌘[)", () => ed.reorder("back"))))
      .child(h_flex().gap(4)
        .child(this.chip(t, "grp", "group", false, "Group (⌘G)", () => ed.group(), 44))
        .child(this.chip(t, "ugrp", "ungroup", false, "Ungroup (⌘⇧G)", () => ed.ungroup(), 54))
        .child(this.chip(t, "dup", "dup", false, "Duplicate (⌘D)", () => ed.cloneSelection(20, 20), 34))
        .child(this.chip(t, "lk", "lock", ed.selected().some(e => e.locked), "Lock (⌘⇧L)", () => ed.toggleLock(), 36)))
      .child(h_flex().gap(4)
        .child(this.chip(t, "rl", "⟲ 15°", false, "Rotate left 15° (<)", () => ed.rotateBy(-15), 44))
        .child(this.chip(t, "rr", "⟳ 15°", false, "Rotate right 15° (>)", () => ed.rotateBy(15), 44))
        .child(this.chip(t, "r90", "⟳ 90°", false, "Rotate 90°", () => ed.rotateBy(90), 44))
        .child(this.chip(t, "r0", "0°", false, "Reset rotation", () => ed.resetRotation(), 30)));
    return this.section(t, "Arrange", body);
  }

  animatePanel(t) {
    const ed = this.ed, n = ed.sel.size, anim = ed.selected()[0]?.customData?.anim?.preset;
    const body = v_flex().gap(6)
      .child(h_flex().flex_wrap().gap(4).children(PRESET_NAMES.map(p => this.chip(t, `an-${p}`, p, anim === p, n ? `Animate the selection: ${p}` : "Select something to animate", () => { if (n) ed.animate(p); }, 40))))
      .child(h_flex().gap(4)
        .child(this.chip(t, "an-clear", "none", false, "Remove the selection's animation", () => ed.clearAnimation(), 40))
        .child(this.chip(t, "an-play", ed.play ? "❚❚ pause" : "▶ play", !!ed.play, "Play the timeline (⇧space)", () => ed.playToggle(), 64)));
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
    const trackW = Math.max(40, this.size.w + (this.sidebar && this.size.w > 360 ? SIDEBAR : 0) - 230);
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
