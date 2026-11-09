// Text files of any size. Herdr's readTextFile stops at 1 MiB, and a board with a few photos
// in it (Excalidraw keeps them inline as base64) passes that quickly. Small files go through
// readTextFile / writeTextFile; big ones through exec (8 MiB of output; past that, in parts), with the text
// written in chunks small enough for writeTextFile and joined by `cat`: never as an argument,
// which macOS caps at ~1 MB.

import { readTextFile, writeTextFile, exec, appHome } from "herdr";

export const SMALL = 900 * 1024;          // bytes we trust readTextFile / writeTextFile with
const CHUNK = 256 * 1024;                 // chars per part: at most 768 KiB of UTF-8
export const MAX = 8 * 1024 * 1024 - 64;  // exec's output limit: up to here a big file is one `cat`
export const LIMIT = 64 * 1024 * 1024;    // past here a board isn't opened at all
// Splits a UTF-8 file into parts of `n` chars (never inside a character) and prints their paths.
// Herdr's runtime has no TextDecoder, so byte slices through exec could cut a character in two.
// perl ships with macOS; the parts go through readTextFile, like big writes go through writeTextFile.
const SPLIT = 'my (undef, $in, $pre, $n) = @ARGV; open(my $f, "<:raw", $in) or die "$!\\n"; local $/; my $s = <$f>; ' +
  'utf8::decode($s) or die "not UTF-8\\n"; for (my ($i, $k) = (0, 0); $i < length $s; $i += $n, $k++) { ' +
  'my $p = sprintf("%s-%04d", $pre, $k); open(my $o, ">:raw", $p) or die "$!\\n"; my $c = substr($s, $i, $n); ' +
  'utf8::encode($c); print $o $c; close $o or die "$!\\n"; print "$p\\n"; }';

const tmpDir = () => `${appHome()}/.cache/herdr-draw/tmp`;

async function size(path) {
  const r = await exec("stat", ["-f", "%z", path]);
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}

// `on`: a machine Herdr knows (a space's `machine`), for a board that lives there; null: this one.
export async function readText(path, { on = null } = {}) {
  if (on) return (await readRemote(path, on)).text;
  try { return await readTextFile(path); }
  catch (e) {
    const n = await size(path);
    if (n == null) throw e;
    if (n > LIMIT) throw new Error(`${path.split("/").pop()} is ${(n / 1048576).toFixed(1)} MB; boards over 64 MB can't be opened here`);
    if (n > MAX) return readParts(path);
    const r = await exec("cat", [path]);
    if (r.code !== 0) throw new Error(r.stderr || `can't read ${path}`);
    return r.stdout;
  }
}

// Past exec's 8 MiB: split into parts small enough for readTextFile, read them, clean up.
async function readParts(path) {
  const dir = tmpDir(), prefix = `${dir}/r${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await exec("mkdir", ["-p", dir]);
  const r = await exec("perl", ["-e", SPLIT, "--", "big-read", path, prefix, String(CHUNK)]);
  const parts = r.stdout.split("\n").filter(Boolean);
  try {
    if (r.code !== 0) throw new Error(r.stderr.trim() || `can't read ${path}`);
    let text = "";
    for (const p of parts) {
      const t = await readTextFile(p);
      if (t == null) throw new Error(`can't read ${path}: a part went missing`);
      text += t;
    }
    return text;
  } finally { if (parts.length) await exec("rm", ["-f", ...parts]); }
}

// UTF-8 size, rounded up (a surrogate pair counts 6, not 4): only ever over the truth.
function bytes(s) {
  if (s.length > SMALL) return s.length;
  let n = s.length;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c > 0x7f) n += c > 0x7ff ? 2 : 1; }
  return n;
}
const small = s => s == null || bytes(s) <= SMALL;

// Writes only if the file still holds `expected` (null: it must not exist). Rejects when
// stale, like writeTextFile. The big path checks then renames: a writer landing between
// the two is lost to that check, a narrower window than none.
export async function writeText(path, text, expected, { on = null } = {}) {
  if (on) return writeRemote(path, text, expected, on);
  if (small(text) && small(expected)) return writeTextFile(path, text, expected);   // atomic check-and-write
  const cur = await readText(path).catch(() => undefined);
  if (cur === undefined || cur !== expected) throw new Error("stale: the file changed since it was read");
  const dir = tmpDir(), stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, parts = [];
  await exec("mkdir", ["-p", dir]);
  for (let i = 0, k = 0; i < text.length; k++) {
    let j = Math.min(text.length, i + CHUNK);
    const c = text.charCodeAt(j - 1);
    if (j < text.length && c >= 0xd800 && c <= 0xdbff) j--;   // never split a surrogate pair
    const part = `${dir}/w${stamp}-${String(k).padStart(4, "0")}`;
    await writeTextFile(part, text.slice(i, j), null);
    parts.push(part); i = j;
  }
  const r = await exec("sh", ["-c", 'out="$1"; shift; cat "$@" > "$out.herdr-tmp" && mv "$out.herdr-tmp" "$out"; s=$?; rm -f "$@"; exit $s', "big-write", path, ...parts]);
  if (r.code !== 0) throw new Error(r.stderr || `can't write ${path}`);
  return null;
}

// ── a board on another machine ─────────────────────────────────────────────────────────────
// Herdr runs commands there (exec's `on`), but can't write a file there or watch one. So a read
// is one `cat` that also prints the file's stamp (inode, mtime, size: an atomic replace, ours or
// drawh's, gives a new inode), a write goes as argument-sized parts into a temp file beside the
// board and is renamed over it only if the stamp is still the one we read (in one shell, on that
// machine), and the pane polls the stamp to see other writers. BSD stat: a macOS machine.

const REMOTE_PART = 128 * 1024;   // chars per argument: at most 384 KiB of UTF-8, under macOS's ~1 MiB argv
const seen = new Map();            // "machine\0path" → { text, stamp } as last read or written
const key = (on, path) => `${on}\0${path}`;
const STAT = 'stat -f "%i:%m:%z" "$1" 2>/dev/null || echo none';

async function readRemote(path, on) {
  const r = await exec("sh", ["-c", `s=$(${STAT}); [ "$s" = none ] && { echo none; exit 0; }; echo "$s"; cat "$1"`, "board-read", path], { on });
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `can't read ${path} on ${on}`);
  const nl = r.stdout.indexOf("\n"), stamp = (nl < 0 ? r.stdout : r.stdout.slice(0, nl)).trim();
  const text = stamp === "none" ? null : r.stdout.slice(nl + 1);
  seen.set(key(on, path), { text, stamp });
  return { text, stamp };
}

// The file's stamp on that machine now ("none": no file).
export async function remoteStamp(path, on) {
  const r = await exec("sh", ["-c", STAT, "board-stat", path], { on });
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `can't reach ${on}`);
  return r.stdout.trim();
}
// Whether the file there changed since this pane last read or wrote it.
export async function remoteChanged(path, on) {
  const s = await remoteStamp(path, on);
  return s !== (seen.get(key(on, path))?.stamp ?? "none");
}

async function writeRemote(path, text, expected, on) {
  const last = seen.get(key(on, path));
  let stamp;
  if (expected === null) stamp = "none";
  else if (last && last.text === expected) stamp = last.stamp;
  else {   // not what we last saw: compare the text itself
    const now = await readRemote(path, on);
    if (now.text !== expected) throw new Error("stale: the file changed since it was read");
    stamp = now.stamp;
  }
  const tmp = `${path}.herdr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    for (let i = 0, first = true; first || i < text.length; first = false) {
      let j = Math.min(text.length, i + REMOTE_PART);
      const c = text.charCodeAt(j - 1);
      if (j < text.length && c >= 0xd800 && c <= 0xdbff) j--;   // never split a surrogate pair
      const r = await exec("sh", ["-c", first ? 'printf %s "$2" > "$1"' : 'printf %s "$2" >> "$1"', "board-part", tmp, text.slice(i, j)], { on });
      if (r.code !== 0) throw new Error(r.stderr?.trim() || `can't write on ${on}`);
      i = j;
    }
    const r = await exec("sh", ["-c", `s=$(${STAT}); [ "$s" = "$3" ] || { rm -f "$2"; echo stale >&2; exit 3; }; mv -f "$2" "$1" && stat -f "%i:%m:%z" "$1"`,
      "board-commit", path, tmp, stamp], { on });
    if (r.code === 3) throw new Error("stale: the file changed since it was read");
    if (r.code !== 0) throw new Error(r.stderr?.trim() || `can't write ${path} on ${on}`);
    seen.set(key(on, path), { text, stamp: r.stdout.trim() });
    return null;
  } catch (e) {
    exec("rm", ["-f", tmp], { on }).catch(() => {});
    throw e;
  }
}
