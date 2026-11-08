// SVG → PNG with headless Chromium (Playwright's cached build). Headless: no window, no input devices.
import { chromium } from "playwright-core";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";

function findChrome() {
  const root = `${homedir()}/Library/Caches/ms-playwright`;
  for (const d of readdirSync(root).filter(d => d.startsWith("chromium_headless_shell")).sort().reverse()) {
    for (const sub of readdirSync(`${root}/${d}`)) {
      const p = `${root}/${d}/${sub}/chrome-headless-shell`;
      if (existsSync(p)) return p;
    }
  }
  throw new Error("no Playwright chromium_headless_shell in " + root);
}

// One browser for the whole run. Test files share this module, so a file must not
// close it for the others: relaunch if it went away, and close only at exit.
let browser = null;
export async function rasterize(svg, outPath, { width, height }) {
  if (!browser?.isConnected()) browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: outPath });
  await page.close();
}
export async function closeRaster() { /* kept open for the other test files; closed at exit */ }
process.on("beforeExit", async () => { const b = browser; browser = null; await b?.close(); });
