// Text layout without a font engine: word wrap by an estimated glyph width.
// Every adapter (Herdr, SVG, a browser later) draws the same lines, so labels
// wrap identically everywhere and the file stays the single source of truth.

// Average glyph width / font size per font class, for the fonts the pane draws with (adapters/herdr
// face()): the system UI sans, a hand font (Chalkboard SE / Comic Sans MS), the terminal's mono.
// Measured in headless Chromium 2026-11-08: sans 0.41-0.47, hand 0.47-0.53, mono 0.60. Set a bit
// high for proportional fonts so wrapped text errs toward fitting its shape.
export const CHAR_W = { sans: 0.5, hand: 0.55, mono: 0.6 };
// Excalidraw fontFamily → class (as core/style.js fontClass; kept here so text.js imports nothing).
export const fontKind = ff => (ff === 1 || ff === 5 || ff === 8 ? "hand" : ff === 3 ? "mono" : "sans");

// Width of one line of text in scene px at this size, in the pane's font for this Excalidraw fontFamily.
export function textWidth(line, fontSize, fontFamily = 2) {
  return String(line ?? "").length * fontSize * CHAR_W[fontKind(fontFamily)];
}
export const LABEL_PAD = 8;        // space between a label and its shape's edge, scene px

// How much of a shape's width a centered label may use (Excalidraw's factors):
// a diamond's middle is half its width; an ellipse's inscribed box is w/√2.
export function labelWidthFactor(type) {
  if (type === "diamond") return 0.5;
  if (type === "ellipse") return Math.SQRT1_2;
  return 1;
}

// Split text into lines no wider than maxW (scene px) at this font size and family.
// Explicit newlines are kept; words much longer than a line are broken.
export function wrapLines(text, maxW, fontSize, fontFamily = 2) {
  const W = t => textWidth(t, fontSize, fontFamily);
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/ +/)) {
      let w = word;
      // A word a bit wider than the line stays whole (widths are estimates, and a slight
      // overflow reads better than "signatur/e"); a much longer one breaks.
      if (W(w) > maxW * 1.5) {
        if (line) { out.push(line); line = ""; }
        while (W(w) > maxW) {
          let n = 1; while (n < w.length && W(w.slice(0, n + 1)) <= maxW) n++;
          out.push(w.slice(0, n)); w = w.slice(n);
        }
      }
      if (!line) line = w;
      else if (W(line + " " + w) <= maxW) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

// The lines a shape's label shows at the shape's current width.
export function labelLines(label, host) {
  const usable = Math.max(label.fontSize, Math.abs(host.width) * labelWidthFactor(host.type) - LABEL_PAD * 2);
  return wrapLines(label.text, usable, label.fontSize, label.fontFamily);
}

// The height a shape needs so its wrapped label fits inside.
export function labelHostHeight(label, host) {
  const lines = labelLines(label, host).length;
  const textH = lines * label.fontSize * (label.lineHeight ?? 1.25);
  const f = host.type === "diamond" ? 0.5 : host.type === "ellipse" ? Math.SQRT1_2 : 1;
  return textH / f + LABEL_PAD * 2;
}
