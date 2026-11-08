import { test, expect } from "bun:test";
import { toSvg } from "../adapters/svg/svg.js";

test("hostile values from a board file can't break out of SVG attributes", () => {
  const bad = '"/><script>alert(1)</script><x a="';
  const svg = toSvg([
    { t: "path", cmds: [["M", 0, 0], ["L", 10, 10]], stroke: bad, width: bad, dash: [bad] },
    { t: "path", cmds: [["M", 0, 0], ["L", 10, 10]], fill: bad, opacity: bad },
    { t: "text", x: 1, y: 2, text: "<b>hi</b>", size: bad, color: bad },
  ], { width: 100, height: 100, background: bad, font: bad });
  expect(svg).not.toContain("<script");
  expect(svg).not.toContain("<b>");
  expect(svg).toContain("&lt;b&gt;hi");
});
