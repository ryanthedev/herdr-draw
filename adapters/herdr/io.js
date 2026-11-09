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

export async function readText(path) {
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
export async function writeText(path, text, expected) {
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
