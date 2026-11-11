// Mermaid flowchart → editable board elements, laid out in layers.
//
// Supported (the flowchart subset people and agents actually write):
//   graph|flowchart TD|TB|BT|LR|RL
//   nodes   A  A[box]  A(round)  A([stadium])  A[[sub]]  A[(db)]  A((circle))  A{diamond}  A{{hex}}  A>flag]
//   edges   -->  ---  -.->  -.-  ==>  ===  with labels: -->|text|  or  -- text -->  ; chains A --> B --> C ; A & B --> C
//   subgraph id [title] ... end   (drawn as a frame around its nodes)
//   %% comments; classDef/class/style/click/linkStyle lines are ignored.
// Pure: no Herdr, DOM or Node imports.

import { makeElement, textSize } from "./model.js";
import { edgePoint } from "./geometry.js";
import { elbowRoute } from "./elbow.js";
import { overlaps } from "./lint.js";
import { labelHostHeight, labelHostWidth, wrapLines, textWidth } from "./text.js";

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
//
// Ranks are doubled: nodes sit on even ranks, and every edge passes through one placeholder
// ("lane") per odd and skipped rank. A lane is as big as the edge's label where the label goes,
// and a thin strip elsewhere, so ordering and spacing keep labels off nodes and off each other,
// edges that skip ranks go around the nodes in between, and A→B / B→A get a lane each.

const GAP_RANK = 45, GAP_NODE = 50, GAP_LANE = 16, LANE = 16, PAD_FRAME = 30, TITLE = 24, EDGE_FS = 16;
const MIN_W = { rectangle: 120, diamond: 140, ellipse: 150 }, MIN_H = { rectangle: 60, diamond: 90, ellipse: 75 };
export const LANE_PREFIX = "\u0000lane:";

// A node's box: the old look (wrapped near 180px, 120..240 wide), never too small for its label:
// its longest word fits whole (labelHostWidth), and its wrapped lines fit inside (labelHostHeight).
function nodeSize(n) {
  const label = { text: n.label, fontSize: 20, fontFamily: 2, lineHeight: 1.25 }, type = n.type;
  const textW = Math.max(...wrapLines(n.label, 180, 20, 2).map(l => textWidth(l, 20, 2)));
  let w = Math.max(120, Math.min(240, textW + 40));
  if (type === "diamond") w = Math.max(w * 1.5, 140); else if (type === "ellipse") w *= 1.25;
  w = Math.max(w, MIN_W[type] ?? 120, labelHostWidth(label, type));
  const h = Math.max(MIN_H[type] ?? 60, labelHostHeight(label, { type, width: w }) + (type === "rectangle" ? 12 : 0));
  return { w, h };
}
const edgeLabelSize = text => { const s = textSize(text, EDGE_FS, 1.25, 2); return { w: s.w + 12, h: s.h + 8 }; };

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
  // Longest-path rank (doubled: nodes on even ranks).
  const rank = new Map(), visit = id => {
    if (rank.has(id)) return rank.get(id);
    rank.set(id, 0);
    const r = inn.get(id).length ? Math.max(...inn.get(id).map(p => visit(p) + 2)) : 0;
    rank.set(id, r); return r;
  };
  ids.forEach(visit);
  const horizontal = g.dir === "LR" || g.dir === "RL";
  const size = new Map(ids.map(id => [id, nodeSize(g.nodes.get(id))]));
  // Lanes: each edge (either way round) gets one per rank strictly between its ends; its label
  // rides the middle one. Ordering runs on the chains, so up/down neighbours are lanes too.
  const up = new Map(ids.map(id => [id, []])), down = new Map(ids.map(id => [id, []]));
  const lanes = g.edges.map((e, i) => {
    const a = rank.get(e.from), b = rank.get(e.to);
    if (e.from === e.to || a === undefined || b === undefined) return [];
    const [lo, hi] = a <= b ? [e.from, e.to] : [e.to, e.from], r0 = rank.get(lo), r1 = rank.get(hi);
    const chain = [lo], mid = r0 + Math.floor((r1 - r0) / 2);   // the middle rank: the label sits halfway along
    for (let r = r0 + 1; r < r1; r++) {
      const id = `${LANE_PREFIX}${i}:${r}`, ls = r === mid && e.label ? edgeLabelSize(e.label) : null;
      rank.set(id, r); up.set(id, []); down.set(id, []);
      size.set(id, ls ? { w: ls.w, h: ls.h, label: true } : { w: LANE, h: LANE, lane: true });
      chain.push(id);
    }
    chain.push(hi);
    for (let k = 1; k < chain.length; k++) { down.get(chain[k - 1]).push(chain[k]); up.get(chain[k]).push(chain[k - 1]); }
    // The route bends only at lanes beside nodes (even ranks) and at the label's lane; an edge
    // with neither keeps its one lane (it parts A→B from B→A; dropped later if it's on the line).
    let inner = chain.slice(1, -1).filter(id => rank.get(id) % 2 === 0 || size.get(id).label);
    if (!inner.length) inner = chain.slice(1, -1);
    return a <= b ? inner : inner.reverse();   // in the edge's own direction
  });
  const all = [...rank.keys()], layers = [];
  for (const id of all) (layers[rank.get(id)] ??= []).push(id);
  for (let r = 0; r < layers.length; r++) layers[r] ??= [];
  // Barycenter passes to reduce crossings, keeping each subgraph's nodes together within a rank
  // (barycenter order inside each group) on every pass, so the ranks around adapt to it.
  const groupOf = new Map();
  g.groups.forEach((grp, i) => grp.nodes.forEach(id => { if (!groupOf.has(id)) groupOf.set(id, i); }));
  const key = id => groupOf.get(id) ?? -1;
  const pos = new Map();
  const order = (layer, by) => {
    layer.sort((a, b) => by(a) - by(b));
    if (layer.some(id => groupOf.has(id))) layer.sort((a, b) => key(a) - key(b));   // stable: barycenter order inside
    layer.forEach((id, i) => pos.set(id, i));
  };
  layers.forEach(l => order(l, id => l.indexOf(id)));
  for (let pass = 0; pass < 8; pass++) {
    const goingDown = pass % 2 === 0;
    const seq = goingDown ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const layer of seq) {
      const bc = id => { const ns = goingDown ? up.get(id) : down.get(id); return ns.length ? ns.reduce((s, x) => s + pos.get(x), 0) / ns.length : pos.get(id); };
      const b = new Map(layer.map(id => [id, bc(id)]));
      order(layer, id => b.get(id));
    }
  }
  // Coordinates: ranks along the flow, items centered across it.
  const along = id => (horizontal ? size.get(id).w : size.get(id).h), across = id => (horizontal ? size.get(id).h : size.get(id).w);
  const gapAcross = (a, b) => (size.get(a).lane || size.get(b).lane || size.get(a).label || size.get(b).label ? GAP_LANE : GAP_NODE);
  const rankDepth = layers.map(l => Math.max(0, ...l.map(along)));
  // Across: start packed and centered, then sweep: each item moves toward the average of its
  // neighbours in the rank before (going down) or after (going up), as far as the items beside
  // it allow. Chains line up, so long edges run straight past the nodes they skip.
  const cx = new Map();
  const sep = (a, b) => across(a) / 2 + gapAcross(a, b) + across(b) / 2;
  const rankWidth = layers.map(l => l.reduce((s, id, i) => s + across(id) + (i ? gapAcross(l[i - 1], id) : 0), 0));
  const widest = Math.max(...rankWidth);
  layers.forEach((l, r) => { let c = (widest - rankWidth[r]) / 2; l.forEach((id, i) => { if (i) c += gapAcross(l[i - 1], id); cx.set(id, c + across(id) / 2); c += across(id); }); });
  for (let pass = 0; pass < 12; pass++) {
    const goingDown = pass % 2 === 0, seq = goingDown ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of seq) {
      const want = l.map(id => { const ns = (goingDown ? up : down).get(id); return ns.length ? ns.reduce((s, x) => s + cx.get(x), 0) / ns.length : cx.get(id); });
      const fwd = [], bwd = [];
      l.forEach((id, i) => { fwd[i] = i ? Math.max(want[i], fwd[i - 1] + sep(l[i - 1], id)) : want[i]; });
      for (let i = l.length - 1; i >= 0; i--) bwd[i] = i < l.length - 1 ? Math.min(want[i], bwd[i + 1] - sep(l[i], l[i + 1])) : want[i];
      l.forEach((id, i) => cx.set(id, (fwd[i] + bwd[i]) / 2));
      l.forEach((id, i) => { if (i) cx.set(id, Math.max(cx.get(id), cx.get(l[i - 1]) + sep(l[i - 1], id))); });
    }
  }
  const lo = Math.min(...[...cx].map(([id, c]) => c - across(id) / 2));
  // Room along the flow for subgraph frames (their padding, and the title above them), so
  // what comes before or after a frame keeps clear of it.
  const room = layers.map(() => 0);
  for (const grp of g.groups) {
    const rs = grp.nodes.map(id => rank.get(id)).filter(r => r !== undefined); if (!rs.length) continue;
    const first = Math.min(...rs), last = Math.max(...rs), titleFirst = !(g.dir === "BT");
    room[first] = Math.max(room[first], PAD_FRAME + (titleFirst || horizontal ? TITLE : 0));
    if (last + 1 < layers.length) room[last + 1] = Math.max(room[last + 1], PAD_FRAME + (!titleFirst && !horizontal ? TITLE : 0));
  }
  const place = new Map();
  let a = 0;
  layers.forEach((layer, r) => {
    if (r) a += room[r];
    for (const id of layer) {
      const s = size.get(id), mid = a + rankDepth[r] / 2, c = cx.get(id) - lo - across(id) / 2;
      const x = horizontal ? mid - s.w / 2 : c, y = horizontal ? c : mid - s.h / 2;
      place.set(id, { x, y, w: s.w, h: s.h });
    }
    a += rankDepth[r] + (r < layers.length - 1 ? GAP_RANK : 0);
  });
  // Flip for bottom-up / right-to-left.
  if (g.dir === "BT" || g.dir === "RL") {
    const total = a;
    for (const p of place.values()) { if (g.dir === "BT") p.y = total - p.y - p.h; else p.x = total - p.x - p.w; }
  }
  // The nodes, by id; .lanes: per edge (as g.edges), the lane boxes it passes through, in order.
  const nodes = new Map(ids.map(id => [id, place.get(id)]));
  nodes.lanes = lanes.map(chain => chain.map(id => place.get(id)));
  nodes.all = place;
  nodes.ranks = rank;
  return nodes;
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
      const members = new Set(grp.nodes);   // and the lanes of edges inside the group
      for (const id of place.all.keys()) if (id.startsWith(LANE_PREFIX)) { const e = g.edges[parseInt(id.slice(LANE_PREFIX.length))]; if (e && members.has(e.from) && members.has(e.to)) members.add(id); }
      for (const [id, p] of place.all) {
        if (members.has(id) || g.groups.some(o => o !== grp && o.nodes.includes(id) && grp.nodes.some(m => o.nodes.includes(m)))) continue;
        const inside = p.x < f.x1 && p.x + p.w > f.x0 && p.y < f.y1 && p.y + p.h > f.y0 - TITLE;   // the title above it too
        if (!inside) continue;
        // Out the nearer side; non-members beyond it in the same rank (same center line) move too.
        const [lo, hi, at, size] = horizontal ? ["y0", "y1", "y", "h"] : ["x0", "x1", "x", "w"];
        const mid = q => (horizontal ? q.x + q.w / 2 : q.y + q.h / 2), c = p[at] + p[size] / 2, right = c >= (f[lo] + f[hi]) / 2;
        const d = right ? f[hi] + 20 - p[at] : f[lo] - 20 - (horizontal ? TITLE : 0) - (p[at] + p[size]);   // above a frame: past its title
        for (const [qid, q] of place.all) {
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
  const laneRoute = new Map(), onLanes = new Set();   // arrow id → its route through its lanes, for edges that collide
  const rankOf = id => place.ranks.get(id);
  for (const [i, e] of g.edges.entries()) {
    const s = idOf.get(e.from), t = idOf.get(e.to); if (!s || !t) continue;
    // Store the arrow already clipped to both outlines, so other tools draw it right too.
    // Straight edges pass through their lanes (bends only where a lane is off the line), as a curve.
    const cOf = b => [b.x + b.w / 2, b.y + b.h / 2];
    const box = el => ({ x: el.x, y: el.y, w: el.width, h: el.height });
    const sc = cOf(box(s)), tc = cOf(box(t));
    let via = (place.lanes[i] ?? []).map(b => { const c = cOf(b); return [origin.x + c[0], origin.y + c[1]]; });
    const offLine = (p, a, b) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
    if (via.every(p => offLine(p, sc, tc) < 1)) via = [];
    const first = via[0] ?? tc, last = via[via.length - 1] ?? sc;
    const lanes = [edgePoint(s, first[0], first[1]), ...via, edgePoint(t, last[0], last[1])];
    const a = makeElement(e.head ? "arrow" : "line", {
      startBinding: { elementId: s.id, focus: 0, gap: 6 }, endBinding: { elementId: t.id, focus: 0, gap: 6 },
      endArrowhead: e.head ? "arrow" : null, strokeStyle: e.style === "dashed" ? "dashed" : "solid", strokeWidth: e.style === "thick" ? 4 : 2,
      customData: cd(),
    });
    // Edges between neighbouring ranks start straight (or as elbows); longer ones go through their lanes.
    const short = Math.abs(rankOf(e.to) - rankOf(e.from)) <= 2;
    if (elbow && e.head) setRoute(a, elbowRoute({ box: box(s) }, { box: box(t) }).points.map(p => [p.x, p.y]), true);
    else setRoute(a, short ? [edgePoint(s, tc[0], tc[1]), edgePoint(t, sc[0], sc[1])] : lanes, false);
    if (!(short || elbow && e.head)) onLanes.add(a.id);
    laneRoute.set(a.id, lanes);
    for (const host of [s, t]) host.boundElements = [...(host.boundElements ?? []), { id: a.id, type: "arrow" }];
    els.push(a);
    if (e.label) {
      const lt = makeElement("text", { x: a.x, y: a.y, text: e.label, originalText: e.label, fontSize: 16, fontFamily: 2, containerId: a.id, textAlign: "center", verticalAlign: "middle", customData: { layer, z: zz } });
      a.boundElements = [{ id: lt.id, type: "text" }];
      els.push(lt);
    }
  }
  // A straight edge or an elbow knows nothing of the others: one that collides with something
  // (A→B beside B→A, labels on a shared trunk, a label on a node) goes through its lanes instead.
  for (let round = 0; round < 3; round++) {
    const bad = new Set(overlaps(els).flatMap(p => p.ids));
    const fix = els.filter(a => laneRoute.has(a.id) && !onLanes.has(a.id) && bad.has(a.id));
    if (!fix.length) break;
    for (const a of fix) { setRoute(a, laneRoute.get(a.id), false); onLanes.add(a.id); }
  }
  return { elements: els, graph: g };
}

// Give an arrow its points (absolute), as an elbow or as a straight edge (a curve when it bends).
function setRoute(a, route, elbowed) {
  const p0 = route[0], xs = route.map(p => p[0]), ys = route.map(p => p[1]);
  Object.assign(a, { x: p0[0], y: p0[1], points: route.map(p => [p[0] - p0[0], p[1] - p0[1]]),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    elbowed, roundness: !elbowed && route.length > 2 ? { type: 2 } : null });
}
