// File store: keeps an .excalidraw file and the editor in step.
// The port it fills is small on purpose — { start(cx), schedule(cx) } — so a
// network transport can sit beside it (or replace it) without touching the editor.

import { readTextFile, writeTextFile, watchFolder } from "herdr";
import { emptyScene } from "./core/model.js";

const SAVE_DELAY = 250;

export class FileStore {
  constructor(file, editor, { onError = () => {}, onExternal = () => {} } = {}) {
    this.file = file; this.ed = editor; this.onError = onError; this.onExternal = onExternal;
    this.disk = null;          // the file's text as last read or written
    this.timer = null; this.saving = false; this.again = false; this.pending = null;
  }

  // `cx` must outlive this call: pass the async cx from cx.spawn.
  async start(cx) {
    try {
      const text = await readTextFile(this.file);
      if (text !== null) { this.ed.load(JSON.parse(text)); this.disk = text; }
      else this.ed.load(emptyScene());
    } catch (e) { this.onError(`Can't read ${this.file}: ${e?.message ?? e}`); }
    cx.notify();
    this.watch(cx);
  }

  // The board changed: save shortly (one write per burst of edits).
  schedule(cx) {
    this.timer?.cancel?.();
    this.timer = cx.timer.after(SAVE_DELAY, cx2 => { this.timer = null; this.save(cx2); });
  }

  async save(cx) {
    if (this.saving) { this.again = true; return; }
    this.saving = true;
    try {
      let text = JSON.stringify(this.ed.scene(), null, 2);
      if (text !== this.disk) {
        try { await writeTextFile(this.file, text, this.disk); this.disk = text; }
        catch {
          // Someone else (an agent) wrote since we last looked: take their edits
          // (newer element versions win), then write the merge.
          const theirs = await readTextFile(this.file);
          if (theirs !== null) this.merge(theirs);
          text = JSON.stringify(this.ed.scene(), null, 2);
          await writeTextFile(this.file, text, theirs);
          this.disk = text;
        }
      }
    } catch (e) { this.onError(`Save failed: ${e?.message ?? e}`); }
    this.saving = false;
    if (this.again) { this.again = false; this.save(cx); }
    cx?.notify?.();
  }

  merge(text) {
    const s = JSON.parse(text);
    const changed = this.ed.receive({ elements: s.elements ?? [], appState: s.appState?.herdr });
    return changed.length;
  }

  watch(cx) {
    const dir = this.file.slice(0, this.file.lastIndexOf("/") + 1), base = this.file.slice(dir.length);
    cx.spawn(async cx => {
      for (;;) {
        const changed = await watchFolder(dir);
        if (!changed.some(p => p.endsWith("/" + base) || p === this.file || p.endsWith(dir) || p.endsWith(dir.slice(0, -1)))) continue;
        const text = await readTextFile(this.file);
        if (text === null || text === this.disk) continue;        // our own write
        if (this.ed.g) { this.pending = text; continue; }        // mid-gesture: after release
        this.absorb(text, cx);
      }
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
