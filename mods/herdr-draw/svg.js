// Display list → SVG. Used for headless test snapshots and for "export as SVG".

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function d(cmds) {
  const f = v => num(v).toFixed(1);
  return cmds.map(c => c[0] === "Q" ? `Q${f(c[3])} ${f(c[4])} ${f(c[1])} ${f(c[2])}` : `${c[0] === "L" ? "L" : "M"}${f(c[1])} ${f(c[2])}`).join("");
}

// Board files can come from anywhere (shared files, pasted clipboards), so every
// value that reaches an attribute is validated or escaped: an exported SVG opened
// in a browser must not run anything.
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

// #rrggbbaa → fill + opacity, since not every SVG renderer reads 8-digit hex.
function color(c, opacity = 1) {
  if (!HEX.test(c ?? "")) return ["#888888", opacity];
  if (c.length === 9) return [c.slice(0, 7), (parseInt(c.slice(7), 16) / 255) * opacity];
  return [c, opacity];
}

const FACES = {
  hand: "Excalifont, Virgil, 'Chalkboard SE', 'Comic Sans MS', cursive",
  mono: "'Cascadia Code', Menlo, Consolas, monospace",
  sans: "Helvetica, Arial, sans-serif",
};
// For SVGs that sips rasterizes: it uses only the first family of a list and falls back to sans if that
// one isn't installed, so name one face per class that macOS ships (the pane passes the faces it draws with).
export const RASTER_FACES = { hand: "Chalkboard SE", mono: "Menlo", sans: "Helvetica" };

// Only base64 raster/SVG data URLs reach an href: a board's `files` are untrusted.
// (An SVG inside <image> can't run script.)
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

// `scale`: pixels per unit. The viewBox stays in drawing units; only the pixel size grows.
// Does a data URL's payload start with its declared raster format's magic bytes? (As base64:
// PNG \x89PNG\r\n\x1a\n, JPEG \xff\xd8\xff, GIF8, RIFF....WEBP.) A rasterizer may sniff content,
// so an SVG labeled image/png must not get through.
function rasterBytes(url) {
  const [, mime, b] = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(url) ?? [];
  if (mime === "image/png") return b.startsWith("iVBORw0KGgo");
  if (mime === "image/jpeg") return b.startsWith("/9j/");
  if (mime === "image/gif") return b.startsWith("R0lGOD");
  if (mime === "image/webp") return b.startsWith("UklGR") && b[11] === "X" && b.slice(12, 16) === "RUJQ";   // "RIFF" … "WEBP" at bytes 8–11
  return false;
}

// `svgImages: false` for anything a rasterizer will read (PNG export): an embedded SVG picture is the
// board's content, and its own links (file://, http) could make sips fetch them. Browsers don't.
export function toSvg(items, { width, height, background, font = FACES.sans, files = {}, scale = 1, svgImages = true, faces = null } = {}) {
  const face = k => (faces?.[k] ? `'${String(faces[k]).replace(/['"\\<>&]/g, "")}'` : FACES[k]);
  width = num(width, 800); height = num(height, 600); scale = num(scale, 1) > 0 ? num(scale, 1) : 1; const base = esc(font ?? FACES.sans);
  const px = v => +(v * scale).toFixed(2);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${width} ${height}">`];
  // Explicit size, not 100%: sips takes a percentage of the pixel size and left a 2x PNG mostly black.
  if (background) out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${color(background)[0]}"/>`);
  for (let it of items) {
    const op = num(it.opacity, 1);
    if (it.t === "path") {
      if (it.fill) { const [c, o] = color(it.fill, op); out.push(`<path d="${d(it.cmds)}Z" fill="${c}" fill-opacity="${o.toFixed(3)}"/>`); }
      else { const [c, o] = color(it.stroke, op); out.push(`<path d="${d(it.cmds)}" fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${num(it.width, 1)}" stroke-linecap="round" stroke-linejoin="round"${Array.isArray(it.dash) ? ` stroke-dasharray="${it.dash.map(v => num(v)).join(" ")}"` : ""}/>`); }
    } else if (it.t === "image") {
      const url = files?.[it.fileId]?.dataURL;
      if (typeof url !== "string" || !DATA_URL.test(url)) continue;
      if (!svgImages && !rasterBytes(url)) continue;
      const deg = num(it.angle) * 180 / Math.PI, x = num(it.x), y = num(it.y), w = Math.max(0, num(it.w)), h = Math.max(0, num(it.h));
      const turn = deg ? ` transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})"` : "";
      out.push(`<image href="${url}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="none" opacity="${op.toFixed(3)}"${turn}/>`);
    } else if (it.t === "text") {
      // Rotated text turns about its center (adapters without text rotation draw it upright).
      const deg = num(it.angle) * 180 / Math.PI;
      if (deg) out.push(`<g transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})">`);
      const font = it.font && FACES[it.font] ? esc(face(it.font)) : base;
      const size = num(it.size, 16), lines = String(it.text).split("\n"), lh = size * num(it.lineHeight, 1.25), [c, o] = color(it.color, op);
      it = { ...it, size, x: num(it.x), y: num(it.y), box: it.box && { x: num(it.box.x), y: num(it.box.y), w: num(it.box.w), h: num(it.box.h) } };
      if (it.box) {
        const cx = it.box.x + it.box.w / 2, top = it.box.y + it.box.h / 2 - (lines.length * lh) / 2;
        lines.forEach((l, i) => out.push(`<text x="${cx.toFixed(1)}" y="${(top + lh * (i + 0.75)).toFixed(1)}" font-family="${font}" font-size="${it.size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}" text-anchor="middle">${esc(l)}</text>`));
      } else {
        lines.forEach((l, i) => out.push(`<text x="${it.x.toFixed(1)}" y="${(it.y + lh * (i + 0.75)).toFixed(1)}" font-family="${font}" font-size="${it.size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}">${esc(l)}</text>`));
      }
      if (deg) out.push("</g>");
    }
  }
  out.push("</svg>");
  return out.join("\n");
}
