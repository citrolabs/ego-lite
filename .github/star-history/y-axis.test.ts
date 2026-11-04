// Run from the pinned action's renderer directory after applying y-axis.patch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import XYChart from "./vendor/shared/packages/xy-chart";

for (const theme of ["light", "dark"] as const) {
  for (const stars of [1, 14001, 19546, 20000, 20001, 99999]) {
    test(`${theme}: Y axis covers ${stars} stars with a labelled upper bound`, () => {
      const dom = new JSDOM("<!DOCTYPE html><body></body>");
      const svg = dom.window.document.createElement("svg");
      dom.window.document.body.append(svg);
      XYChart(svg as unknown as SVGSVGElement, {
        title: "Star History", xLabel: "Date", yLabel: "GitHub Stars",
        data: { datasets: [{ label: "test/repo", logo: "", data: [
          { x: new Date("2026-05-01"), y: 0 },
          { x: new Date("2026-10-26"), y: stars },
        ] }] },
        showDots: false, transparent: false, theme,
      }, { xTickLabelType: "Date", chartWidth: 800 });
      const ticks = [...svg.querySelectorAll(".yaxis .tick")];
      const upper = ticks[ticks.length - 1];
      assert(upper);
      assert((upper as unknown as { __data__: number }).__data__ >= stars);
      assert.match(upper.getAttribute("transform") ?? "", /^translate\(0,0(?:\.5)?\)$/);
      if (stars === 19546) assert.equal(upper.textContent, "20K");
      dom.window.close();
    });
  }
}
