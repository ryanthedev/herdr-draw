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

let browser = null;
export async function rasterize(svg, outPath, { width, height }) {
  browser ??= await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: outPath });
  await page.close();
}
export async function closeRaster() { await browser?.close(); browser = null; }
