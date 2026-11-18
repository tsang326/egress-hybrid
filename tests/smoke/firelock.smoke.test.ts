import { test } from "vitest";
import { runFire } from "../../src/core/fire";
import { SAMPLES } from "../../src/core/plan/samples";
import { toFireScenario } from "../../src/core/plan/scenario";
test("cafe fire, D1 locked", () => {
  const { plan, scenario } = SAMPLES[Number(process.env.S ?? 0)]!;
  const t0 = performance.now(); let last = 0;
  const r = runFire(toFireScenario(plan, { ...scenario, lockedDoors: (process.env.L ?? "D1").split(","), durationS: Number(process.env.DUR ?? 600) }), { now: () => performance.now(), onProgress: (e) => { if (performance.now() - last > 3000) { last = performance.now(); console.log("sim", e.simTimeS.toFixed(1), "wall", Math.round(performance.now() - t0)); } } });
  console.log(r.status, Math.round(performance.now() - t0), "ms", r.stats.steps, "steps", r.stats.rejected, "rej");
}, 120000);
