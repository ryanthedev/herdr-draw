// Prints the glyph-width tables in core/text.js: the advance of each printable ASCII char
// (32-126) as a fraction of the font size, in the fonts the Herdr pane draws with.
//   node scripts/glyph-widths.mjs
// Sans: the pane uses .SystemUIFont (SF Pro). Measured live 2026-11-08 at zoom 1.2 on a 2x display,
// a 40px sentence in the pane averaged 0.471 per char, which is SF Pro's small-size (16px) spacing
// (0.4695), not its large-size spacing (0.436 at 40px): so the table is SF Pro at 16px.
// Hand: Chalkboard SE (the pane's first installed hand font on macOS; live 0.479, table 0.481).
import { chromium } from "playwright-core";
import { readdirSync, existsSync } from "node:fs";

const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
let exe;
for (const d of readdirSync(root).filter(d => d.startsWith("chromium_headless_shell")).sort().reverse())
  for (const s of readdirSync(`${root}/${d}`)) { const p = `${root}/${d}/${s}/chrome-headless-shell`; if (existsSync(p)) exe ??= p; }
const b = await chromium.launch({ executablePath: exe, headless: true });
const page = await b.newPage();
const fonts = { sans: ['"SF Pro"', 16], hand: ['"Chalkboard SE"', 100] };
for (const [k, [family, px]] of Object.entries(fonts)) {
  const w = await page.evaluate(([family, px]) => {
    const c = document.createElement("canvas").getContext("2d"); c.font = `${px}px ${family}`;
    // Each char's own advance (measuring between neighbours picks up kerning and came out 2.5% narrow).
    return Array.from({ length: 95 }, (_, i) => +(c.measureText(String.fromCharCode(32 + i)).width / px).toFixed(3));
  }, [family, px]);
  console.log(`  ${k}: [${w.join(", ")}],`);
}
await b.close();
