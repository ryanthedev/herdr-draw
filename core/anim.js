// Animation: each element may carry customData.anim, played on the board's timeline.
//
//   anim = { preset, start, duration, easing?, loop? }      a preset (below), or
//   anim = { keys: [{ t, dx?, dy?, opacity?, scale?, progress? }, ...] }   keyframes, t in ms
//
// Elements without anim are simply there. animState(el, t) says how an element
// looks at time t; render.js applies it. Nothing here knows about frames or timers:
// adapters advance `t` however their platform animates.

export const PRESETS = {
  fade:   { from: { opacity: 0 }, to: { opacity: 1 } },
  rise:   { from: { opacity: 0, dy: 30 }, to: { opacity: 1, dy: 0 } },
  slide:  { from: { opacity: 0, dx: -60 }, to: { opacity: 1, dx: 0 } },
  pop:    { from: { opacity: 0, scale: 0.6 }, to: { opacity: 1, scale: 1 }, easing: "back" },
  draw:   { from: { progress: 0 }, to: { progress: 1 }, easing: "inout" },
  pulse:  { from: { scale: 1 }, mid: { scale: 1.12 }, to: { scale: 1 }, loop: true },
  out:    { from: { opacity: 1 }, to: { opacity: 0 } },
};
export const PRESET_NAMES = Object.keys(PRESETS);

const REST = { opacity: 1, dx: 0, dy: 0, scale: 1, progress: 1 };

export const EASE = {
  linear: t => t,
  in: t => t * t,
  out: t => 1 - (1 - t) * (1 - t),
  inout: t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  back: t => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
};

const lerp = (a, b, k) => a + (b - a) * k;
const mix = (a, b, k) => {
  const o = {};
  for (const key of Object.keys(REST)) o[key] = lerp(a[key] ?? REST[key], b[key] ?? REST[key], k);
  return o;
};

export function animState(el, t) {
  const anim = el.customData?.anim;
  if (!anim) return null;
  if (Array.isArray(anim.keys) && anim.keys.length) {
    const ks = [...anim.keys].sort((a, b) => a.t - b.t);
    if (t <= ks[0].t) return mix(ks[0], ks[0], 0);
    for (let i = 1; i < ks.length; i++) if (t <= ks[i].t) {
      const k = (t - ks[i - 1].t) / ((ks[i].t - ks[i - 1].t) || 1);
      return mix(ks[i - 1], ks[i], (EASE[ks[i].easing] ?? EASE.inout)(k));
    }
    return mix(ks[ks.length - 1], ks[ks.length - 1], 0);
  }
  const p = PRESETS[anim.preset];
  if (!p) return null;
  const start = anim.start ?? 0, dur = Math.max(1, anim.duration ?? 600);
  let k = (t - start) / dur;
  if (p.loop || anim.loop) k = k < 0 ? 0 : k % 1;
  k = Math.max(0, Math.min(1, k));
  const e = (EASE[anim.easing ?? p.easing ?? "out"] ?? EASE.out)(k);
  if (p.mid) return e < 0.5 ? mix({ ...REST, ...p.from }, { ...REST, ...p.mid }, e * 2) : mix({ ...REST, ...p.mid }, { ...REST, ...p.to }, (e - 0.5) * 2);
  return mix({ ...REST, ...p.from }, { ...REST, ...p.to }, e);
}

// When does the last animation end? (The timeline's natural length.)
export function timelineEnd(elements) {
  let end = 0;
  for (const el of elements) {
    const a = el.customData?.anim; if (!a) continue;
    if (Array.isArray(a.keys)) end = Math.max(end, ...a.keys.map(k => k.t));
    else end = Math.max(end, (a.start ?? 0) + (a.duration ?? 600));
  }
  return end;
}
