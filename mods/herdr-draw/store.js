// File store: keeps an .excalidraw file and the editor in step.
// The port it fills is small on purpose — { start(cx), schedule(cx) } — so a
// network transport can sit beside it (or replace it) without touching the editor.

import { watchFolder } from "herdr";
import { readText, writeText, remoteChanged, remoteBusy } from "./io.js";   // any size (Herdr's own stop at 1 MiB), here or on another machine
import { emptyScene } from "./core/model.js";

const SAVE_DELAY = 250;
const POLL_MS = 1500;   // a board on another machine: how often to look for other writers (no watching there)

export class FileStore {
  // `on`: the machine the file lives on (a space's `machine`), null for this one.
  // `locate(file)`: when `on` isn't given, finds the machine that has the file (null: this one).
  constructor(file, editor, { on = null, locate = null, onLocated = () => {}, onError = () => {}, onExternal = () => {} } = {}) {
    this.on = on; this.locate = locate; this.onLocated = onLocated; this.file = file; this.ed = editor; this.onError = onError; this.onExternal = onExternal;
    this.disk = null;          // the file's text as last read or written
    this.timer = null; this.saving = false; this.again = false; this.pending = null;
  }

  // `cx` must outlive this call: pass the async cx from cx.spawn.
  async start(cx) {
    // A pane made on another machine (drawh open there) names only a path; this Herdr draws it too.
    if (!this.on && this.locate) {
      try { const m = await this.locate(this.file); if (m) { this.on = m; this.onLocated(m); } } catch {}
    }
    try {
      const text = await this.read();
      if (text !== null) { this.ed.load(JSON.parse(text)); this.disk = text; }
      else this.ed.load(emptyScene());
    } catch (e) { this.onError(`Can't read ${this.file}: ${e?.message ?? e}`); }
    cx.notify();
    this.watch(cx);
  }

  // The pane moves to another board: no more saves or reads for this file. Save first (flush).
  stop() { this.stopped = true; this.timer?.cancel?.(); this.timer = null; }
  async flush(cx) { this.timer?.cancel?.(); this.timer = null; await this.save(cx); }

  // The board changed: save shortly (one write per burst of edits).
  schedule(cx) {
    if (this.stopped) return;
    this.timer?.cancel?.();
    this.timer = cx.timer.after(SAVE_DELAY, cx2 => { this.timer = null; this.save(cx2); });
  }

  async save(cx) {
    if (this.saving) { this.again = true; return; }
    this.saving = true;
    try {
      let text = JSON.stringify(this.ed.scene(), null, 2);
      if (text !== this.disk) {
        try { await this.write(text, this.disk); this.disk = text; }
        catch {
          // Someone else (an agent) wrote since we last looked: take their edits
          // (newer element versions win), then write the merge.
          const theirs = await this.read();
          if (theirs !== null) this.merge(theirs);
          text = JSON.stringify(this.ed.scene(), null, 2);
          await this.write(text, theirs);
          this.disk = text;
        }
      }
    } catch (e) { this.onError(`Save failed: ${e?.message ?? e}`); }
    this.saving = false;
    if (this.again) { this.again = false; this.save(cx); }
    cx?.notify?.();
  }

  read() { return readText(this.file, { on: this.on }); }
  write(text, expected) { return writeText(this.file, text, expected, { on: this.on }); }

  merge(text) {
    const s = JSON.parse(text);
    const changed = this.ed.receive({ elements: s.elements ?? [], appState: s.appState?.herdr, files: s.files });
    return changed.length;
  }

  watch(cx) {
    if (this.on) return this.poll(cx);
    const dir = this.file.slice(0, this.file.lastIndexOf("/") + 1), base = this.file.slice(dir.length);
    cx.spawn(async cx => {
      for (;;) {
        const changed = await watchFolder(dir);
        if (this.stopped) return;
        if (!changed.some(p => p.endsWith("/" + base) || p === this.file || p.endsWith(dir) || p.endsWith(dir.slice(0, -1)))) continue;
        // One bad read must not end live updates for good: report it and keep watching.
        let text;
        try { text = await this.read(); } catch (e) { this.onError(`Can't read ${this.file}: ${e?.message ?? e}`); cx.notify(); continue; }
        if (text === null || text === this.disk) continue;        // our own write
        if (this.ed.g) { this.pending = text; continue; }        // mid-gesture: after release
        this.absorb(text, cx);
      }
    });
  }

  // Another machine's file can't be watched: look at its stamp every POLL_MS (one small command).
  // A slow or unreachable machine backs the checks off (up to a minute); the pane closing stops them.
  poll(cx) {
    let busy = false, skip = 0, backoff = 0;
    const t = cx.timer.every(POLL_MS, async cx => {
      if (this.stopped) { t.cancel(); return; }
      if (busy || this.saving || remoteBusy()) return;
      if (skip > 0) { skip--; return; }
      busy = true;
      try {
        const changed = await remoteChanged(this.file, this.on);
        if (backoff) { backoff = 0; this.onError(null); cx.notify(); }
        if (!changed) return;
        const text = await this.read();
        if (this.stopped || text === null || text === this.disk) return;
        if (this.ed.g) { this.pending = text; return; }
        this.absorb(text, cx);
      } catch (e) {
        backoff = Math.min(40, backoff ? backoff * 2 : 2); skip = backoff;
        this.onError(`Can't reach ${this.on}: ${e?.message ?? e}`); cx.notify();
      }
      finally { busy = false; }
    });
  }

  absorb(text, cx) {
    try { const n = this.merge(text); this.disk = text; if (n) this.onExternal(n); }
    catch (e) { this.onError(`The file changed but isn't valid: ${e?.message ?? e}`); }
    cx?.notify?.();
  }

  // Called by the view after a gesture ends.
  flushPending(cx) { if (this.pending && !this.ed.g) { const t = this.pending; this.pending = null; this.absorb(t, cx); } }
}
