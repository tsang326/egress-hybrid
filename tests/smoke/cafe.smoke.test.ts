import { test, expect } from "vitest";
import { runFire } from "../../src/core/fire";
import { SAMPLES } from "../../src/core/plan/samples";
import { toFireScenario } from "../../src/core/plan/scenario";
import { checkPlan } from "../../src/core/plan/types";

for (const { plan, scenario } of SAMPLES) {
  test(`sample ${plan.title} runs`, () => {
    expect(checkPlan(plan)).toEqual([]);
    const t0 = performance.now();
    const r = runFire(toFireScenario(plan, scenario));
    console.log(plan.title, r.status, Math.round(performance.now() - t0), "ms", r.warnings.map((w) => JSON.stringify(w)).slice(0, 4));
    const last = r.timesS.length - 1;
    for (const c of r.compartments) console.log("  ", c.id, `${Math.round(c.upperTempK[last]! - 273)}C`, c.interfaceHeightM[last]!.toFixed(2), "m vis", c.upper.visibilityM[last]!.toFixed(1));
    expect(r.status).toBe("ok");
  }, 300000);
}
