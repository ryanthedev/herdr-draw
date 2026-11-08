// Display list → SVG. Used for headless test snapshots and for "export as SVG".

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function d(cmds) {
  return cmds.map(c => c[0] === "Q" ? `Q${c[3].toFixed(1)} ${c[4].toFixed(1)} ${c[1].toFixed(1)} ${c[2].toFixed(1)}` : `${c[0]}${c[1].toFixed(1)} ${c[2].toFixed(1)}`).join("");
}

// #rrggbbaa → fill + opacity, since not every SVG renderer reads 8-digit hex.
function color(c, opacity = 1) {
  if (c && c.length === 9) return [c.slice(0, 7), (parseInt(c.slice(7), 16) / 255) * opacity];
  return [c, opacity];
}

export function toSvg(items, { width, height, background, font = "Helvetica, Arial, sans-serif" } = {}) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  if (background) out.push(`<rect width="100%" height="100%" fill="${background}"/>`);
  for (const it of items) {
    const op = it.opacity ?? 1;
    if (it.t === "path") {
      if (it.fill) { const [c, o] = color(it.fill, op); out.push(`<path d="${d(it.cmds)}Z" fill="${c}" fill-opacity="${o.toFixed(3)}"/>`); }
      else { const [c, o] = color(it.stroke, op); out.push(`<path d="${d(it.cmds)}" fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${it.dash.join(" ")}"` : ""}/>`); }
    } else if (it.t === "text") {
      const lines = String(it.text).split("\n"), lh = it.size * (it.lineHeight ?? 1.25), [c, o] = color(it.color, op);
      if (it.box) {
        const cx = it.box.x + it.box.w / 2, top = it.box.y + it.box.h / 2 - (lines.length * lh) / 2;
        lines.forEach((l, i) => out.push(`<text x="${cx.toFixed(1)}" y="${(top + lh * (i + 0.75)).toFixed(1)}" font-family="${font}" font-size="${it.size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}" text-anchor="middle">${esc(l)}</text>`));
      } else {
        lines.forEach((l, i) => out.push(`<text x="${it.x.toFixed(1)}" y="${(it.y + lh * (i + 0.75)).toFixed(1)}" font-family="${font}" font-size="${it.size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}">${esc(l)}</text>`));
      }
    }
  }
  out.push("</svg>");
  return out.join("\n");
}
