// Color math for the color picker, free of Herdr so it's tested headless: parsing what a person
// types, hex ↔ RGB ↔ HSV (the picker's hue strip and shade square), and the recent-colors list.
//
// Colors are stored the way Excalidraw stores them: "#rrggbb" in lower case, or "transparent".

export const RECENT_COLORS_MAX = 8;

// What a person typed (or a file held) as a stored color, or null if it isn't one.
// Takes #rgb, #rrggbb, either without the #, any case, and "transparent".
export function normalizeColor(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "transparent") return s;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  return "#" + h;
}

export function hexToRgb(hex) {
  const c = normalizeColor(hex);
  if (!c || c === "transparent") return null;
  const n = parseInt(c.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const p = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

// h in degrees [0, 360), s and v in [0, 1].
export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }) {
  h = (((Number(h) || 0) % 360) + 360) % 360;
  s = clamp01(s); v = clamp01(v);
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export const hexToHsv = hex => { const rgb = hexToRgb(hex); return rgb ? rgbToHsv(rgb) : null; };
export const hsvToHex = hsv => rgbToHex(hsvToRgb(hsv));

// Newest first, unique, at most RECENT_COLORS_MAX; anything that isn't a color is ignored.
export function pushRecentColor(list, color, max = RECENT_COLORS_MAX) {
  const c = normalizeColor(color);
  const clean = (Array.isArray(list) ? list : []).map(normalizeColor).filter(Boolean);
  if (!c) return clean.slice(0, max);
  return [c, ...clean.filter(x => x !== c)].slice(0, max);
}

// Black or white, whichever reads better on `hex` (for a check mark or a label on a swatch).
export function inkOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#000000";
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return L > 0.179 ? "#000000" : "#ffffff";
}

function clamp01(v) { v = Number(v); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
