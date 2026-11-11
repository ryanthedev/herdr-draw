// The library file the sidebar shows: <appHome>/herdr-draw/library.excalidrawlib (drawh uses the
// same path). Read and written through io.js (a picture in it passes 1 MiB quickly); only its own
// folder is watched, so `drawh lib` changes show up live.

import { watchFolder, appHome, exec } from "herdr";
import { readText, writeText } from "./io.js";
import { parseLibrary, serializeLibrary } from "./core/library.js";

export const libDir = () => `${appHome()}/herdr-draw`;
export const libFile = () => `${libDir()}/library.excalidrawlib`;

export class LibraryStore {
  constructor({ onChange = () => {}, onError = () => {} } = {}) {
    this.items = []; this.disk = null; this.onChange = onChange; this.onError = onError;
  }

  // `cx`: the async cx from cx.spawn (it outlives this call).
  async start(cx) {
    await exec("mkdir", ["-p", libDir()]);   // watchable from the start
    await this.reload();
    cx.notify();
    cx.spawn(async cx => {
      for (;;) {
        const changed = await watchFolder(libDir()).catch(() => null);
        if (!changed) return;   // can't watch (folder removed): live updates stop; reopen the pane
        if (!changed.some(p => p.endsWith("library.excalidrawlib") || p.endsWith("/herdr-draw"))) continue;
        if (await this.reload()) { this.onChange(); cx.notify(); }
      }
    });
  }

  // Re-read the file; true if it changed.
  async reload() {
    try {
      const text = await readText(libFile());
      if (text === this.disk) return false;
      this.items = text == null ? [] : parseLibrary(text);
      this.disk = text;
      return true;
    } catch (e) { this.onError(`Library: ${e?.message ?? e}`); return false; }
  }

  // Apply fn(items) → items and write it. If someone (drawh) wrote meanwhile, take theirs and apply again.
  async update(fn) {
    await exec("mkdir", ["-p", libDir()]);
    for (let i = 0; i < 3; i++) {
      const next = fn(this.items), text = serializeLibrary(next);
      try { await writeText(libFile(), text, this.disk); this.items = next; this.disk = text; return true; }
      catch { await this.reload(); }
    }
    this.onError("Library: the file keeps changing; try again");
    return false;
  }
}
