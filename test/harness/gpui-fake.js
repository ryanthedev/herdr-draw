// A stand-in for Herdr's gpui-kit, gpui-base and herdr modules, so the real
// adapter (build/herdr-draw/main.js) runs headless under bun. Elements record
// their styles, children and handlers; tests fire handlers like GPUI would and
// paint the canvas to SVG.

import { mock } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const THEME = {
  foreground: "#e6e6e6", background: "#0b0f10", accent: "#5eead4", accent_foreground: "#04211d", dim: "#6b7280", muted: "#9ca3af",
  border: "#1f2a2e", surface: "#11171a", hover: "#1a2327", blocked: "#f87171",
};

export function makeEl(kind, extra = {}) {
  const node = { kind, style: {}, handlers: {}, children: [], ...extra };
  const proxy = new Proxy(node, {
    get(t, prop) {
      if (prop === "__node") return node;
      if (typeof prop === "symbol") return undefined;
      if (prop === "child") return c => { if (c != null) node.children.push(c.__node ?? c); return proxy; };
      if (prop === "children") return cs => { for (const c of cs) if (c != null) node.children.push(c.__node ?? c); return proxy; };
      if (prop === "when") return (cond, f) => (cond ? f(proxy) : proxy);
      if (prop === "map") return f => f(proxy);
      if (prop === "hover") return () => proxy;
      if (prop.startsWith("on_")) return (...args) => { node.handlers[typeof args[0] === "string" ? `${prop}:${args[0]}` : prop] = args[args.length - 1]; return proxy; };
      return (...args) => { node.style[prop] = args.length <= 1 ? (args.length ? args[0] : true) : args; return proxy; };
    },
  });
  return proxy;
}

class FakePath {
  constructor(kind, width) { this.kind = kind; this.width = width; this.cmds = []; this.dash = null; }
  move_to(x, y) { this.cmds.push(["M", x, y]); return this; }
  line_to(x, y) { this.cmds.push(["L", x, y]); return this; }
  curve_to(x, y, cx, cy) { this.cmds.push(["Q", x, y, cx, cy]); return this; }
  close() { this.closed = true; return this; }
  dash_array(d) { this.dash = d; return this; }
  add_polygon(pts, closed) { pts.forEach((p, i) => this.cmds.push([i ? "L" : "M", p[0], p[1]])); if (closed) this.closed = true; return this; }
  build() { return this; }
}

class FakeInput {
  constructor({ value = "" } = {}) { this.v = value; this.handlers = {}; this.focused = false; }
  value() { return this.v; }
  set_value(v) { this.v = v; }
  focus() { this.focused = true; }
  on(ev, fn) { this.handlers[ev] = fn; return true; }
  // Test helpers: type and press Enter like a person.
  type(text, cx) { this.v = text; this.handlers.change?.({}, cx); }
  submit(cx) { this.handlers.submit?.({}, cx); }
}

export function installFakes({ file, home }) {
  const calls = { exec: [], notify: 0 };
  globalThis.window = { paint_path: (path, color) => makeEl("path", { path, color }) };
  mock.module("gpui-kit", () => ({
    View: class {},
    div: () => makeEl("div"),
    PathBuilder: { fill: () => new FakePath("fill"), stroke: w => new FakePath("stroke", w) },
  }));
  mock.module("gpui-base", () => ({
    v_flex: () => makeEl("div", { flex: "col" }),
    h_flex: () => makeEl("div", { flex: "row" }),
    InputState: { new: o => new FakeInput(o) },
    Input: { new: state => makeEl("input", { state }) },
  }));
  mock.module("herdr", () => ({
    props: () => ({ file }),
    theme: () => THEME,
    settings: () => ({ zoom: 1 }),
    home: () => home,
    panes: () => [],
    nextCommand: () => new Promise(() => {}),
    watchFolder: () => new Promise(() => {}),
    readTextFile: async p => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeTextFile: async (p, text, expected) => {
      const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (cur !== expected) throw new Error("stale");
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return null;
    },
    exec: async (cmd, args) => { calls.exec.push([cmd, ...args]); return { stdout: "", stderr: "", code: 0 }; },
  }));
  return calls;
}

// GPUI-ish contexts. An event's cx dies when its handler returns (real GPUI
// rejects a stashed cx); spawn/timer callbacks get a long-lived async cx.
// Timers are queued and run by flush().
export function makeCx(calls) {
  const timers = [];
  const make = (kind) => {
    let alive = true;
    const guard = (name, fn) => (...a) => { if (!alive) throw new Error(`stale cx: ${name}() on an ${kind} context after its call returned`); return fn(...a); };
    const cx = {
      notify: guard("notify", () => { calls.notify++; }),
      spawn: guard("spawn", fn => { const p = Promise.resolve().then(() => fn(asyncCx)); p.catch(e => { calls.errors = (calls.errors ?? []).concat(String(e)); }); return { cancel() {}, is_done: () => false, p }; }),
      focus_handle: guard("focus_handle", () => ({ focus() {} })),
      stop_propagation: guard("stop_propagation", () => {}),
      timer: {
        after: guard("timer.after", (ms, fn) => { const t = { ms, fn, every: false, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(t); return t; }),
        every: guard("timer.every", (ms, fn) => { const t = { ms, fn, every: true, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(t); return t; }),
      },
      expire() { alive = false; },
    };
    return cx;
  };
  const asyncCx = make("async");
  return {
    // A fresh context for one host call; expired as soon as `fn` returns.
    call(fn) { const cx = make("event"); try { return fn(cx); } finally { cx.expire(); } },
    async: asyncCx,
    async flush(rounds = 3) {
      for (let r = 0; r < rounds; r++) {
        const due = timers.splice(0).filter(t => !t.cancelled);
        for (const t of due) { await t.fn(asyncCx); if (t.every && !t.cancelled) timers.push(t); }
        await new Promise(res => setTimeout(res, 5));
      }
      if (calls.errors?.length) { const e = calls.errors; calls.errors = []; throw new Error(e.join("\n")); }
    },
  };
}

export function find(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children ?? []) { if (typeof c !== "object") continue; const f = find(c, pred); if (f) return f; }
  return null;
}
export const byId = (tree, id) => find(tree, n => n.style?.id === id);
export function textOf(node) {
  if (node == null) return "";
  if (typeof node !== "object") return String(node);
  return (node.children ?? []).map(textOf).join("");
}

// Paint the canvas node the way GPUI would: path layers, then absolutely placed text.
export function canvasToSvg(canvas, { width, height, bg }) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`, `<rect width="100%" height="100%" fill="${bg}"/>`];
  const color = c => (c?.length === 9 ? [c.slice(0, 7), parseInt(c.slice(7), 16) / 255] : [c, 1]);
  const f = n => n.toFixed(1);
  const d = cmds => cmds.map(c => (c[0] === "Q" ? `Q${f(c[3])} ${f(c[4])} ${f(c[1])} ${f(c[2])}` : `${c[0]}${f(c[1])} ${f(c[2])}`)).join("");
  const walk = (n, ox, oy) => {
    if (typeof n !== "object" || !n) return;
    if (n.kind === "path") {
      const [c, o] = color(n.color), p = n.path;
      out.push(p.kind === "fill" ? `<path d="${d(p.cmds)}Z" fill="${c}" fill-opacity="${o}"/>` : `<path d="${d(p.cmds)}" fill="none" stroke="${c}" stroke-opacity="${o}" stroke-width="${p.width}" stroke-linecap="round"${p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : ""}/>`);
      return;
    }
    const x = ox + (n.style.left ?? 0), y = oy + (n.style.top ?? 0);
    if (n.kind === "input") { out.push(`<rect x="${x}" y="${y}" width="160" height="28" fill="none" stroke="#5eead4"/><text x="${x + 6}" y="${y + 19}" fill="#e6e6e6" font-size="14" font-family="Helvetica">${n.state.value()}|</text>`); return; }
    if (n.style.text_size && n.children.every(c => typeof c === "object" && c.kind === "div" && c.children.every(k => typeof k !== "object"))) {
      const size = n.style.text_size, [c, o] = color(n.style.text_color ?? "#e6e6e6"), lines = n.children.map(textOf);
      const center = n.style.items_center;
      lines.forEach((l, i) => out.push(`<text x="${center ? x + (n.__boxW ?? 0) / 2 : x}" y="${y + size * 1.25 * (i + 0.8)}" font-size="${size}" font-family="Helvetica" fill="${c}" fill-opacity="${o}"${center ? ' text-anchor="middle"' : ""}>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`));
      return;
    }
    for (const c of n.children) {
      if (typeof c === "object" && c && n.style.justify_center && n.style.h != null) { c.__boxW = n.style.w; c.style.top = (c.style.top ?? 0) + n.style.h / 2 - (c.style.text_size ?? 16) * 1.25 * c.children.length / 2; }
      walk(c, x, y);
    }
  };
  for (const c of canvas.children) walk(c, 0, 0);
  out.push("</svg>");
  return out.join("\n");
}
