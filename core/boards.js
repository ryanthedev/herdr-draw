// The board picker's logic, free of Herdr so it's tested headless: which boards to offer for a
// query (recent first when there's no query), the recent list, and a new board's file name.
//
// A board is any *.excalidraw file. Paths are absolute; `home` shortens them for display.

export const BOARD = /\.excalidraw(\.json)?$/i;
export const RECENT_MAX = 30;

export const boardName = p => String(p).split("/").pop().replace(BOARD, "");
export const folderOf = p => String(p).slice(0, String(p).lastIndexOf("/"));
export const tilde = (p, home) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

// recent.json: newest first, unique, at most RECENT_MAX. Anything malformed reads as empty.
export function parseRecent(text) {
  try { const v = JSON.parse(text ?? "[]"); return Array.isArray(v) ? v.filter(p => typeof p === "string" && BOARD.test(p)) : []; } catch { return []; }
}
export function pushRecent(list, file) { return [file, ...list.filter(p => p !== file)].slice(0, RECENT_MAX); }

// How well `q` matches `s` (both lower case): exact name > prefix > word start > substring >
// letters in order; null when it doesn't. Higher is better.
function score(q, s) {
  if (!q) return 0;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 800 - s.length;
  const at = s.indexOf(q);
  if (at > 0 && /[\s_\-./]/.test(s[at - 1])) return 600 - at;
  if (at >= 0) return 400 - at;
  let i = 0, gaps = 0, last = -1;
  for (let k = 0; k < s.length && i < q.length; k++) if (s[k] === q[i]) { if (last >= 0) gaps += k - last - 1; last = k; i++; }
  return i === q.length ? 200 - gaps : null;
}

// Rows for the picker: { path, name, folder, recent }. The name counts more than the folder.
// No query: recent boards (newest first), then the rest by modification time (newest first).
export function rankBoards(query, files, recent = [], { home = "", current = null } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  const seen = new Set(), all = [];
  const mtime = new Map(files.map(f => [f.path, f.mtime ?? 0]));
  for (const p of [...recent, ...files.map(f => f.path)]) if (!seen.has(p)) { seen.add(p); all.push(p); }
  const rows = [];
  for (const path of all) {
    const name = boardName(path), folder = tilde(folderOf(path), home), ri = recent.indexOf(path);
    let s = 0;
    if (q) {
      const n = score(q, name.toLowerCase()), f = score(q, `${folder}/${name}`.toLowerCase());
      if (n == null && f == null) continue;
      s = Math.max(n == null ? -1e9 : n + 300, f == null ? -1e9 : f);
    }
    rows.push({ path, name, folder, recent: ri >= 0, current: path === current, s, ri, m: mtime.get(path) ?? 0 });
  }
  rows.sort((a, b) => b.s - a.s || (a.ri < 0) - (b.ri < 0) || (a.ri >= 0 && b.ri >= 0 ? a.ri - b.ri : b.m - a.m) || a.name.localeCompare(b.name));
  return rows.map(({ s, ri, m, ...r }) => r);
}

// A new board's file in `dir` for the name typed: kept readable (spaces, case) but safe as a
// file name, and never one that exists (`taken` holds paths) — a number is added instead.
export function newBoardPath(dir, name, taken = new Set()) {
  let base = String(name ?? "").trim().replace(BOARD, "").replace(/[\/\\:*?"<>|\x00-\x1f]+/g, "-").replace(/^[.\s-]+|[\s-]+$/g, "").slice(0, 80) || "Untitled";
  let p = `${dir}/${base}.excalidraw`;
  for (let n = 2; taken.has(p); n++) p = `${dir}/${base} ${n}.excalidraw`;
  return p;
}

// `find` output with `stat -f '%m %N'` lines ("<mtime> <path>") → [{ path, mtime }], boards only.
export function parseListing(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\d+) (\/.+)$/.exec(line.trim());
    if (m && BOARD.test(m[2])) out.push({ path: m[2], mtime: +m[1] });
  }
  return out;
}
