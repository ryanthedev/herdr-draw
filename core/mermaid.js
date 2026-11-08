// Mermaid flowchart → editable board elements, laid out in layers.
//
// Supported (the flowchart subset people and agents actually write):
//   graph|flowchart TD|TB|BT|LR|RL
//   nodes   A  A[box]  A(round)  A([stadium])  A[[sub]]  A[(db)]  A((circle))  A{diamond}  A{{hex}}  A>flag]
//   edges   -->  ---  -.->  -.-  ==>  ===  with labels: -->|text|  or  -- text -->  ; chains A --> B --> C ; A & B --> C
//   subgraph id [title] ... end   (drawn as a frame around its nodes)
//   %% comments; classDef/class/style/click/linkStyle lines are ignored.
// Pure: no Herdr, DOM or Node imports.

import { makeElement } from "./model.js";
import { edgePoint } from "./geometry.js";
import { elbowRoute } from "./elbow.js";
import { labelHostHeight, wrapLines, CHAR_W } from "./text.js";

const SHAPES = [
  // [open, close, element type], longest openers first so "((" wins over "(".
  ["([", "])", "rectangle"], ["[[", "]]", "rectangle"], ["[(", ")]", "rectangle"], ["((", "))", "ellipse"],
  ["{{", "}}", "diamond"], ["[", "]", "rectangle"], ["(", ")", "rectangle"], ["{", "}", "diamond"], [">", "]", "rectangle"],
];

const ARROW = /^(<?)(-->|---|-\.->|-\.-|==>|===|--x|--o)(?:\|([^|]*)\|)?/;
const TEXT_ARROW = /^(--|==|-\.)\s*([^-=.>][^>]*?)\s*(-->|==>|\.->|---|===|-\.-)/;

export function isMermaid(text) { return /^\s*(%%[^\n]*\n\s*)*(graph|flowchart)\b/i.test(String(text ?? "")); }

// Parse into { dir, nodes: Map id → {id, label, type, rounded}, edges: [{from, to, label, style, head}], groups: [{id, title, nodes}] }.
export function parseMermaid(src) {
  const lines = String(src).replace(/\r/g, "").split(/\n|;/).map(l => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  const head = lines.shift() ?? "";
  const m = /^(graph|flowchart)\s*(TD|TB|BT|LR|RL)?/i.exec(head);
  if (!m) throw new Error("not a Mermaid flowchart (expected `graph TD` or `flowchart LR` first)");
  const dir = (m[2] ?? "TD").toUpperCase().replace("TB", "TD");
  const nodes = new Map(), edges = [], groups = [], stack = [];

  const node = (id, label, type, rounded) => {
    let n = nodes.get(id);
    if (!n) { n = { id, label: id, type: "rectangle", rounded: false }; nodes.set(id, n); }
    if (label != null) { n.label = label; n.type = type; n.rounded = rounded; }
    for (const g of stack) if (!g.nodes.includes(id)) g.nodes.push(id);
    return n;
  };

  // Read one node reference at the start of s: returns [id, rest] (and registers it).
  const readNode = s => {
    const idm = /^([\p{L}\p{N}_]+)/u.exec(s);   // letters, digits, _ (no "-": `A-->B` must split)
    if (!idm) throw new Error(`can't read a node at: ${s.slice(0, 30)}`);
    const id = idm[1]; let rest = s.slice(id.length);
    for (const [open, close, type] of SHAPES) {
      if (!rest.startsWith(open)) continue;
      const end = rest.indexOf(close, open.length);
      if (end < 0) continue;
      let label = rest.slice(open.length, end).trim().replace(/^"(.*)"$/s, "$1");
      label = label.replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n");
      node(id, label, type, open === "(" || open === "([");
      return [id, rest.slice(end + close.length).trim()];
    }
    node(id);
    return [id, rest.trim()];
  };
  const readGroup = s => {   // A & B & C
    const ids = []; let rest = s;
    for (;;) { const [id, r] = readNode(rest); ids.push(id); rest = r; if (!rest.startsWith("&")) return [ids, rest]; rest = rest.slice(1).trim(); }
  };

  for (const line of lines) {
    if (/^(classDef|class|style|click|linkStyle|direction)\b/.test(line)) continue;
    const sg = /^subgraph\s+([^\s[]+)\s*(?:\[(.*)\])?\s*(.*)$/.exec(line);
    if (sg) { const g = { id: sg[1], title: (sg[2] ?? sg[3] ?? sg[1]).trim() || sg[1], nodes: [] }; groups.push(g); stack.push(g); continue; }
    if (line === "end") { stack.pop(); continue; }
    let [from, rest] = readGroup(line);
    while (rest) {
      let style = "solid", head = true, label = null, a;
      if ((a = ARROW.exec(rest))) {
        const op = a[2]; label = a[3]?.trim() || null;
        if (op.includes(".")) style = "dashed";
        if (op.startsWith("==")) style = "thick";
        head = op.endsWith(">") || op.endsWith("x") || op.endsWith("o");
        rest = rest.slice(a[0].length).trim();
      } else if ((a = TEXT_ARROW.exec(rest))) {
        label = a[2].trim();
        if (a[1] === "-.") style = "dashed"; if (a[1] === "==") style = "thick";
        head = a[3].endsWith(">");
        rest = rest.slice(a[0].length).trim();
      } else break;
      const [to, r] = readGroup(rest); rest = r;
      for (const f of from) for (const t of to) edges.push({ from: f, to: t, label, style, head });
      from = to;
    }
  }
  return { dir, nodes, edges, groups };
}

// ── layout: layered (longest-path ranks, barycenter ordering) ───────────────

const GAP_RANK = 90, GAP_NODE = 50, PAD_FRAME = 30;

function nodeSize(n) {
  const fs = 20, maxW = 180;
  const lines = wrapLines(n.label, maxW, fs);
  const textW = Math.max(...lines.map(l => l.length)) * fs * CHAR_W;
  let w = Math.max(120, Math.min(240, textW + 40)), h = Math.max(60, lines.length * fs * 1.25 + 28);
  if (n.type === "diamond") { w = Math.max(w * 1.5, 140); h = Math.max(h * 1.6, 90); }
  if (n.type === "ellipse") { w *= 1.25; h *= 1.25; }
  return { w, h };
}

export function layoutGraph(g) {
  const ids = [...g.nodes.keys()];
  const out = new Map(ids.map(id => [id, []])), inn = new Map(ids.map(id => [id, []]));
  // Break cycles: drop edges that go back to a node on the DFS stack.
  const state = new Map(), forward = [];
  const dfs = id => {
    state.set(id, 1);
    for (const e of g.edges.filter(e => e.from === id)) {
      if (state.get(e.to) === 1) continue;           // back edge: ignore for ranking
      forward.push(e);
      if (!state.get(e.to)) dfs(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) dfs(id);
  for (const e of forward) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); }
  // Longest-path rank.
  const rank = new Map(), visit = id => {
    if (rank.has(id)) return rank.get(id);
    rank.set(id, 0);
    const r = inn.get(id).length ? Math.max(...inn.get(id).map(p => visit(p) + 1)) : 0;
    rank.set(id, r); return r;
  };
  ids.forEach(visit);
  const layers = [];
  for (const id of ids) (layers[rank.get(id)] ??= []).push(id);
  // Barycenter passes to reduce crossings.
  const pos = new Map(); layers.forEach(l => l.forEach((id, i) => pos.set(id, i)));
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0;
    const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const layer of seq) {
      const bc = id => { const ns = down ? inn.get(id) : out.get(id); return ns.length ? ns.reduce((s, x) => s + pos.get(x), 0) / ns.length : pos.get(id); };
      layer.sort((a, b) => bc(a) - bc(b));
      layer.forEach((id, i) => pos.set(id, i));
    }
  }
  // Keep each subgraph's nodes together within a rank (barycenter order inside each group).
  const groupOf = new Map();
  g.groups.forEach((grp, i) => grp.nodes.forEach(id => { if (!groupOf.has(id)) groupOf.set(id, i); }));
  for (const layer of layers) {
    const key = id => groupOf.get(id) ?? -1;
    layer.sort((a, b) => key(a) - key(b) || pos.get(a) - pos.get(b));
    layer.forEach((id, i) => pos.set(id, i));
  }
  // Coordinates: ranks along the flow, nodes centered across it.
  const size = new Map(ids.map(id => [id, nodeSize(g.nodes.get(id))]));
  const horizontal = g.dir === "LR" || g.dir === "RL";
  const along = id => (horizontal ? size.get(id).w : size.get(id).h), across = id => (horizontal ? size.get(id).h : size.get(id).w);
  const rankDepth = layers.map(l => Math.max(...l.map(along)));
  const rankWidth = layers.map(l => l.reduce((s, id) => s + across(id), 0) + GAP_NODE * (l.length - 1));
  const widest = Math.max(...rankWidth);
  const place = new Map();
  let a = 0;
  layers.forEach((layer, r) => {
    let c = (widest - rankWidth[r]) / 2;
    for (const id of layer) {
      const s = size.get(id), mid = a + rankDepth[r] / 2;
      const x = horizontal ? mid - s.w / 2 : c, y = horizontal ? c : mid - s.h / 2;
      place.set(id, { x, y, w: s.w, h: s.h });
      c += across(id) + GAP_NODE;
    }
    a += rankDepth[r] + GAP_RANK;
  });
  // Flip for bottom-up / right-to-left.
  if (g.dir === "BT" || g.dir === "RL") {
    const total = a - GAP_RANK;
    for (const p of place.values()) { if (g.dir === "BT") p.y = total - p.y - p.h; else p.x = total - p.x - p.w; }
  }
  return place;
}

// Build elements at `origin` (scene coords of the diagram's top-left).
export function mermaidToElements(src, { origin = { x: 0, y: 0 }, layer = "base", z = 0, elbow = false } = {}) {
  const g = parseMermaid(src), place = layoutGraph(g), els = [], idOf = new Map();
  let zz = z;
  const cd = () => ({ layer, z: ++zz });
  // A node that isn't in a subgraph must not sit inside its frame: push it out sideways
  // (across the flow), along with whatever is beyond it in that rank.
  const horizontal = g.dir === "LR" || g.dir === "RL";
  const frameOf = grp => {
    const ps = grp.nodes.map(id => place.get(id)).filter(Boolean); if (!ps.length) return null;
    return { x0: Math.min(...ps.map(p => p.x)) - PAD_FRAME, y0: Math.min(...ps.map(p => p.y)) - PAD_FRAME,
             x1: Math.max(...ps.map(p => p.x + p.w)) + PAD_FRAME, y1: Math.max(...ps.map(p => p.y + p.h)) + PAD_FRAME };
  };
  for (let round = 0; round < 3; round++) {
    for (const grp of g.groups) {
      const f = frameOf(grp); if (!f) continue;
      const members = new Set(grp.nodes);
      for (const [id, p] of place) {
        if (members.has(id) || g.groups.some(o => o !== grp && o.nodes.includes(id) && grp.nodes.some(m => o.nodes.includes(m)))) continue;
        const inside = p.x < f.x1 && p.x + p.w > f.x0 && p.y < f.y1 && p.y + p.h > f.y0;
        if (!inside) continue;
        // Out the nearer side; non-members beyond it in the same rank (same center line) move too.
        const [lo, hi, at, size] = horizontal ? ["y0", "y1", "y", "h"] : ["x0", "x1", "x", "w"];
        const mid = q => (horizontal ? q.x + q.w / 2 : q.y + q.h / 2), c = p[at] + p[size] / 2, right = c >= (f[lo] + f[hi]) / 2;
        const d = right ? f[hi] + 20 - p[at] : f[lo] - 20 - (p[at] + p[size]);
        for (const [qid, q] of place) {
          if (q === p || members.has(qid) || Math.abs(mid(q) - mid(p)) > 1) continue;
          if (right ? q[at] >= p[at] : q[at] <= p[at]) q[at] += d;
        }
        p[at] += d;
      }
    }
  }
  // Frames first (under everything), sized around their nodes.
  for (const grp of g.groups) {
    const f = frameOf(grp); if (!f) continue;
    const x0 = f.x0, y0 = f.y0, x1 = f.x1, y1 = f.y1;
    els.push(makeElement("frame", { x: origin.x + x0, y: origin.y + y0, width: x1 - x0, height: y1 - y0, name: grp.title, strokeWidth: 1, customData: { layer, z: z - 1 } }));
  }
  for (const [id, n] of g.nodes) {
    const p = place.get(id);
    const el = makeElement(n.type, { x: origin.x + p.x, y: origin.y + p.y, width: p.w, height: p.h, roundness: n.rounded ? { type: 3 } : null, customData: cd() });
    const label = makeElement("text", { x: el.x, y: el.y, text: n.label, originalText: n.label, fontFamily: 2, containerId: el.id, textAlign: "center", verticalAlign: "middle", customData: { layer, z: zz } });
    el.boundElements = [{ id: label.id, type: "text" }];
    const need = labelHostHeight(label, el); if (el.height < need) el.height = need;
    idOf.set(id, el); els.push(el, label);
  }
  for (const e of g.edges) {
    const s = idOf.get(e.from), t = idOf.get(e.to); if (!s || !t) continue;
    // Store the arrow already clipped to both outlines, so other tools draw it right too.
    const sc = [s.x + s.width / 2, s.y + s.height / 2], tc = [t.x + t.width / 2, t.y + t.height / 2];
    const box = el => ({ x: el.x, y: el.y, w: el.width, h: el.height });
    const route = elbow && e.head ? elbowRoute({ box: box(s) }, { box: box(t) }).points.map(p => [p.x, p.y]) : [edgePoint(s, tc[0], tc[1]), edgePoint(t, sc[0], sc[1])];
    const p0 = route[0], xs = route.map(p => p[0]), ys = route.map(p => p[1]);
    const a = makeElement(e.head ? "arrow" : "line", {
      x: p0[0], y: p0[1], points: route.map(p => [p[0] - p0[0], p[1] - p0[1]]), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      elbowed: !!(elbow && e.head),
      startBinding: { elementId: s.id, focus: 0, gap: 6 }, endBinding: { elementId: t.id, focus: 0, gap: 6 },
      endArrowhead: e.head ? "arrow" : null, strokeStyle: e.style === "dashed" ? "dashed" : "solid", strokeWidth: e.style === "thick" ? 4 : 2,
      customData: cd(),
    });
    for (const host of [s, t]) host.boundElements = [...(host.boundElements ?? []), { id: a.id, type: "arrow" }];
    els.push(a);
    if (e.label) {
      const lt = makeElement("text", { x: a.x, y: a.y, text: e.label, originalText: e.label, fontSize: 16, fontFamily: 2, containerId: a.id, textAlign: "center", verticalAlign: "middle", customData: { layer, z: zz } });
      a.boundElements = [{ id: lt.id, type: "text" }];
      els.push(lt);
    }
  }
  return { elements: els, graph: g };
}
