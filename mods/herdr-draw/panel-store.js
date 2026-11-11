// The side panel's settings, one set for every board: <appHome>/herdr-draw/panel.json.
//
// Herdr runs this module once and shares it with every copy of the mod (AGENTS.md: "Module code
// runs once per source version and is shared by copies"), so the state below is the one all
// board panes draw from: a change in one pane shows in the others at once. No host call runs at
// the top level; the first pane to open loads the file.

import { appHome, readTextFile, writeTextFile, exec } from "herdr";
import { parsePanel, serializePanel, applyPanel, defaultPanel } from "./core/panel.js";

export const panelDir = () => `${appHome()}/herdr-draw`;
export const panelFile = () => `${panelDir()}/panel.json`;

const S = { state: defaultPanel(), disk: null, loading: null, waiters: new Set(), saving: Promise.resolve() };

export const panelState = () => S.state;

// Read panel.json once (later calls wait for the same read).
export function loadPanel() {
  S.loading ??= (async () => {
    try { S.disk = await readTextFile(panelFile()); } catch { S.disk = null; }
    S.state = parsePanel(S.disk);
    wake();
  })();
  return S.loading;
}

// Apply one core op. `save: false` while a drag is under way (the drag's end saves).
// Returns true if anything changed.
export function changePanel(op, { save = true } = {}) {
  const next = applyPanel(S.state, op);
  if (next === S.state) return false;
  S.state = next;
  wake();
  if (save) savePanel();
  return true;
}

// Writes go one after another; the last state wins. Another Herdr window writing meanwhile
// (a test window on its own home doesn't: it has its own file) is overwritten, not merged.
export function savePanel() {
  S.saving = S.saving.then(async () => {
    const text = serializePanel(S.state);
    if (text === S.disk) return;
    try {
      await exec("mkdir", ["-p", panelDir()]);
      try { await writeTextFile(panelFile(), text, S.disk); }
      catch { await writeTextFile(panelFile(), text, await readTextFile(panelFile()).catch(() => null)); }
      S.disk = text;
    } catch { /* settings stay in memory; the next change tries again */ }
  });
  return S.saving;
}

// Resolves at the next change. A pane awaits it in a cx.spawn loop and calls its own cx.notify():
// no pane ever holds another pane's cx.
export const panelChanged = () => new Promise(r => S.waiters.add(r));

function wake() { const w = [...S.waiters]; S.waiters.clear(); for (const r of w) r(); }

// Tests start from a clean slate.
export function resetPanelStore() { S.state = defaultPanel(); S.disk = null; S.loading = null; wake(); }
