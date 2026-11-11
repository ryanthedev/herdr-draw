// mods/herdr-draw is what people install (herdr.dev copies it): it must be the current build.
import { test, expect } from "bun:test";
const ROOT = new URL("..", import.meta.url).pathname;

test("mods/herdr-draw is the current build (run scripts/release.sh)", () => {
  const b = Bun.spawnSync(["sh", `${ROOT}scripts/build.sh`]);
  expect(b.exitCode).toBe(0);
  const d = Bun.spawnSync(["diff", "-rq", `${ROOT}build/herdr-draw`, `${ROOT}mods/herdr-draw`]);
  expect(d.stdout.toString()).toBe("");
  expect(d.exitCode).toBe(0);
});
