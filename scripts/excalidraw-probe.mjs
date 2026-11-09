// Open a board in the real excalidraw.com, headless, to check how it reads our files.
//   node scripts/excalidraw-probe.mjs BOARD.excalidraw OUT.png [ELEMENT_ID]
// Drops the file onto the canvas in headless Chromium (Playwright's cached build; nothing is
// uploaded: excalidraw.com keeps a dropped file in the page's localStorage), prints the arrows as
// excalidraw.com restored them, and screenshots. With ELEMENT_ID, first drags that element down
// 150 px in the page, to see how bound arrows re-route. Needs network access to excalidraw.com.
// A .excalidrawlib works too (excalidraw.com opens its library panel instead).
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename } from "node:path";

const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
let exe;
for (const d of readdirSync(root).filter(d => d.startsWith("chromium_headless_shell")).sort().reverse())
  for (const s of readdirSync(`${root}/${d}`)) { const p = `${root}/${d}/${s}/chrome-headless-shell`; if (existsSync(p)) exe ??= p; }

const [file, shot, drag] = process.argv.slice(2);
if (!file || !shot) { console.error("usage: excalidraw-probe.mjs BOARD OUT.png [ELEMENT_ID]"); process.exit(2); }
const b = await chromium.launch({ executablePath: exe, headless: true });
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("https://excalidraw.com", { waitUntil: "networkidle" });
await page.waitForSelector("canvas.interactive", { timeout: 30000 });
await page.evaluate(async ([text, name]) => {
  const dt = new DataTransfer(); dt.items.add(new File([text], name, { type: "application/json" }));
  const target = document.querySelector("canvas.interactive");
  for (const t of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 600, clientY: 400 }));
}, [readFileSync(file, "utf8"), basename(file)]);
await page.waitForTimeout(2500);
const scene = () => page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw") || "[]"));
if (drag) {
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw-state") || "{}"));
  const el = (await scene()).find(e => e.id === drag);
  if (!el) throw new Error(`no element ${drag} in excalidraw.com's copy`);
  const z = st.zoom?.value ?? 1, sx = (el.x + 4 + st.scrollX) * z, sy = (el.y + el.height / 2 + st.scrollY) * z;
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx, sy + 15 * i);
  await page.mouse.up(); await page.waitForTimeout(800);
}
for (const e of (await scene()).filter(e => e.type === "arrow"))
  console.log(JSON.stringify({ id: e.id, elbowed: e.elbowed, x: e.x, y: e.y, points: e.points, startBinding: e.startBinding, endBinding: e.endBinding }));
await page.screenshot({ path: shot });
await b.close();
