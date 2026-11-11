// Board panes and the popped-out panel, as one module copy every pane of this build shares (Herdr runs
// a mod's module once for all its copies). The panel window drives the board used last; each side wakes
// the other through here, and each redraws with its own cx (no cx crosses panes).
// A pane on another build has another copy of this module: the panel window finds no board there.

const boards = new Set();
let active = null, popout = null;

export const addBoard = b => { boards.add(b); if (!active) active = b; };
export const removeBoard = b => { boards.delete(b); if (active === b) active = [...boards].pop() ?? null; ping("boards"); };
// The board the panel window works on: the last one used.
export const useBoard = b => { if (active !== b) { active = b; ping("boards"); } };
export const activeBoard = () => active;
// The open panel window's overlay id (null: docked).
export const popoutId = () => popout;
export const setPopout = id => { popout = id ?? null; ping("popout"); };

// Each listening copy gets every change, in order, even two in one tick (a one-shot promise would
// drop the second while its owner hasn't asked again yet). next() resolves with what changed:
// "board", "panel", "popout" or "boards".
const listeners = new Set();
export function listen() {
  const l = { queue: [], wake: null };
  listeners.add(l);
  return {
    next: () => (l.queue.length ? Promise.resolve(l.queue.shift()) : new Promise(r => { l.wake = r; })),
    stop: () => listeners.delete(l),
  };
}
export function ping(what) {
  for (const l of listeners) {
    if (l.wake) { const w = l.wake; l.wake = null; w(what); }
    else if (!l.queue.includes(what)) l.queue.push(what);
  }
}
