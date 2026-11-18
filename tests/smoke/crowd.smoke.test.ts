import { test, expect } from "vitest";
import { SAMPLES } from "../../src/core/plan/samples";
import { runCrowd } from "../../src/core/crowd/sim";
import { standardPolicy } from "../../src/core/crowd/standardPolicy";

test("cafe crowd without fire", async () => {
  const { plan, scenario } = SAMPLES[0]!;
  const t0 = performance.now();
  const r = await runCrowd(plan, scenario, null, standardPolicy, { fallback: standardPolicy, onProgress: (t) => { if (t % 50 === 0) console.log("t", t, Math.round(performance.now() - t0)); } });
  const by = (o: string) => r.agents.filter((a) => a.outcome === o).length;
  console.log(Math.round(performance.now() - t0), "ms | out", by("out"), "incap", by("incapacitated"), "shelter", by("sheltering"), "inside", by("inside"), "end", r.endTimeS);
  console.log("  doors", r.doors.filter((d) => d.passed).map((d) => `${d.doorId}:${d.passed}/q${d.maxQueue}`).join(" "));
  for (const a of r.agents.slice(0, 3)) console.log("  ", a.name, a.persona, a.outcome, a.timeS, a.decisions.map((d) => `${d.timeS}s ${d.trigger}: ${d.chosen}`).join(" | "));
  expect(by("out")).toBeGreaterThan(0);
}, 60000);
