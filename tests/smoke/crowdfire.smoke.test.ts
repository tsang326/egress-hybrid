import { test } from "vitest";
import { runFire } from "../../src/core/fire";
import { SAMPLES } from "../../src/core/plan/samples";
import { toFireScenario } from "../../src/core/plan/scenario";
import { runCrowd } from "../../src/core/crowd/sim";
import { standardPolicy } from "../../src/core/crowd/standardPolicy";
const which = Number(process.env.S ?? 0); const locked = (process.env.L ?? "").split(",").filter(Boolean);
test("crowd+fire", async () => {
  const { plan, scenario } = SAMPLES[which]!;
  const s = { ...scenario, lockedDoors: locked };
  const fire = runFire(toFireScenario(plan, s));
  console.log("fire", fire.status);
  const t0 = performance.now(); let lastT = -1;
  const r = await runCrowd(plan, s, fire, standardPolicy, { fallback: standardPolicy, onProgress: (t) => { if (t - lastT >= 60) { lastT = t; console.log("t", t, Math.round(performance.now() - t0)); } } });
  const by = (o: string) => r.agents.filter((a) => a.outcome === o).length;
  console.log(plan.title, locked, Math.round(performance.now() - t0), "ms | out", by("out"), "incap", by("incapacitated"), "shelter", by("sheltering"), "inside", by("inside"), "end", r.endTimeS);
  console.log("  doors", r.doors.filter((d) => d.passed).map((d) => `${d.doorId}:${d.passed}/q${d.maxQueue}`).join(" "));
  for (const a of r.agents.filter((a) => a.outcome !== "out").slice(0, 4)) console.log("  ", a.name, a.persona, a.outcome, a.cause, a.timeS, a.decisions.map((d) => `${d.timeS}s ${d.trigger}: ${d.chosen}`).join(" | "));
}, 100000);
