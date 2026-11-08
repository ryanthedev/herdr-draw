// herdr-draw — the Herdr adapter. Thin on purpose: it turns GPUI events into
// editor calls and the editor's display list into GPUI elements. All behavior
// lives in ./core (tested headless with `bun test`).
//
// Open: pane.split {mod: "herdr-draw", props: {file}}. Agents use `drawh`.

import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, exec, theme, settings, home, nextCommand, panes, readTextFile, writeTextFile, fonts } from "herdr";
import { Editor, TOOLS, STROKES, FILLS, WIDTHS, STYLES } from "./core/editor.js";
import { withAlpha, paintScene } from "./core/render.js";
import { PRESET_NAMES } from "./core/anim.js";
import { FONT_FAMILY } from "./core/style.js";
import { isShape, isLabel, layerOf } from "./core/model.js";
import { toSvg } from "./svg.js";
import { FileStore } from "./store.js";

const MOD = "herdr-draw";
const Z = () => Number(settings().zoom) || 1;
const CACHE = () => `${home()}/.cache/herdr-draw`;
const SIDEBAR = 232;
const ALIGN = [["left", "⇤"], ["hcenter", "↔"], ["right", "⇥"], ["top", "⤒"], ["vcenter", "↕"], ["bottom", "⤓"]];
const CLEAR = "#00000000";

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
    if (this.file) {
      this.store = new FileStore(this.file, this.ed, {
        onError: m => { this.error = m; },
        onExternal: n => { this.flash = `${n} change${n === 1 ? "" : "s"} from the file`; },
      });
      cx.spawn(async acx => { await this.store.start(acx); this.fitted = false; this.maybeFit(); acx.notify(); });
    }
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "fit") this.ed.fit();
        else if (c === "play") this.ed.playToggle();
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
      cx.spawn(async cx => { const r = await exec("sh", ["-c", "LANG=en_US.UTF-8 pbpaste"]); ed.paste(r.stdout ?? ""); this.after(cx); });
      cx.stop_propagation(); return;
    }
    if (!ed.text && m.platform && m.shift && e.key === "e") { this.exportSvg(); cx.stop_propagation(); return this.after(cx); }
    if (!ed.text && !m.platform && !m.control && e.key === "i") { this.sidebar = !this.sidebar; cx.stop_propagation(); return this.after(cx); }
    if (ed.key(e.key, mm)) { cx.stop_propagation(); this.after(cx); }
  }

  canvasEvents(el) {
    const ed = this.ed;
    return el
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

  exportSvg() {
    const ed = this.ed, pal = this.palette(), saved = { view: { ...ed.view }, size: { ...ed.size } };
    ed.size = { w: 1600, h: 1000 }; ed.fit(undefined, 40);
    const svg = toSvg(paintScene(ed.doc, ed.view, pal), { width: 1600, height: 1000, background: pal.bg });
    ed.view = saved.view; ed.size = saved.size; ed.changed();
    const out = this.file.replace(/\.excalidraw(\.json)?$/, "") + ".svg";
    // Not through a shell argument: a big board's SVG passes macOS's ~1 MB argv limit.
    readTextFile(out).then(old => writeTextFile(out, svg, old)).then(() => { this.flash = `exported ${out.split("/").pop()}`; })
      .catch(e => { this.error = `Export failed: ${e?.message ?? e}`; });
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
    const items = this.ed.displayList(this.palette());
    const layers = [], texts = [];
    // Consecutive paths with one style become one native path; order is kept.
    let cur = null;
    for (const it of items) {
      if (it.t === "text") { cur = null; texts.push(it); continue; }
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
    const tool = this.ed.tool;
    let el = div().id("draw-canvas").flex_1().min_w(0).h_full().relative().overflow_hidden();
    if (tool === "hand") el = el.cursor_grab(); else if (tool !== "select") el = el.cursor_crosshair();
    return this.canvasEvents(el)
      .children(layers.filter(l => l.n).map(l => div().absolute().top(0).left(0).size_full().child(window.paint_path(l.b.build(), l.color))))
      .children(texts.map(it => this.textItem(it, t)))
      .when(!this.ed.doc.live().length && !this.error, e => e.child(this.emptyHint(t)))
      .when(!!this.ed.text, e => e.child(this.textInput(t)));
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
      .child(this.layersPanel(t));
  }

  chip(t, id, label, active, tip, fn, w = 26) {
    return div().id(id).h(24).min_w(w).px(4).rounded(5).flex().items_center().justify_center().text_size(12)
      .border(1).border_color(active ? t.accent : t.border).bg(active ? withAlpha(t.accent, 0.18) : CLEAR)
      .hover(s => s.bg(t.hover)).cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => { fn(); this.handle.focus(); this.after(cx); }).child(label);
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
