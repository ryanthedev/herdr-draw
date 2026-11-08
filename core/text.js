// Text layout without a font engine: word wrap by an estimated glyph width.
// Every adapter (Herdr, SVG, a browser later) draws the same lines, so labels
// wrap identically everywhere and the file stays the single source of truth.

export const CHAR_W = 0.56;        // average glyph width / font size (estimate)
export const LABEL_PAD = 8;        // space between a label and its shape's edge, scene px

// How much of a shape's width a centered label may use (Excalidraw's factors):
// a diamond's middle is half its width; an ellipse's inscribed box is w/√2.
export function labelWidthFactor(type) {
  if (type === "diamond") return 0.5;
  if (type === "ellipse") return Math.SQRT1_2;
  return 1;
}

// Split text into lines no wider than maxW (scene px) at this font size.
// Explicit newlines are kept; words much longer than a line are broken.
export function wrapLines(text, maxW, fontSize) {
  const perLine = Math.max(1, Math.floor(maxW / (fontSize * CHAR_W)));
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/ +/)) {
      let w = word;
      // A word a bit wider than the line stays whole (the width is only an estimate,
      // and a slight overflow reads better than "signatur/e"); a much longer one breaks.
      const fits = w.length <= Math.ceil(perLine * 1.5);
      while (!fits && w.length > perLine) {
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, perLine)); w = w.slice(perLine);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= perLine) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

// The lines a shape's label shows at the shape's current width.
export function labelLines(label, host) {
  const usable = Math.max(label.fontSize, Math.abs(host.width) * labelWidthFactor(host.type) - LABEL_PAD * 2);
  return wrapLines(label.text, usable, label.fontSize);
}

// The height a shape needs so its wrapped label fits inside.
export function labelHostHeight(label, host) {
  const lines = labelLines(label, host).length;
  const textH = lines * label.fontSize * (label.lineHeight ?? 1.25);
  const f = host.type === "diamond" ? 0.5 : host.type === "ellipse" ? Math.SQRT1_2 : 1;
  return textH / f + LABEL_PAD * 2;
}
