// Run-level property tests, part B (tasks.md 10.4): Properties 10, 24, 35 and 36.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { runFire } from "../../src/core/fire";
import { minLayerVolumeM3 } from "../../src/core/fire/gas/minVolume";
import type { Result, Scenario } from "../../src/core/fire/types";
import { arbScenario, withTimeLimit } from "./arbitraries";

const SMALL = { maxCompartments: 2, maxFires: 1, maxVents: 2 } as const;
const MAX_DURATION_S = 20; // keeps each run small; Property 29 (task 10.5) owns the full-length runs
const TEST_TIMEOUT_MS = 1_200_000; // 100+ runs per property; each run is still held to the 10 s limit by withTimeLimit
const arbSmall: fc.Arbitrary<Scenario> = arbScenario(SMALL).map((s) => {
  const durationS = Math.min(s.durationS, MAX_DURATION_S);
  return { ...s, durationS, printIntervalS: Math.min(s.printIntervalS, durationS) };
});
const run = (s: Scenario, recordSteps = true): Result =>
  withTimeLimit(() => runFire(structuredClone(s), { recordSteps }));

/** Bit-level deep equality: Object.is on every number, typed arrays and plain objects compared structurally. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && same((a as never)[k], (b as never)[k]));
  }
  return false;
}

const stepTimes = (r: Result): number[] => {
  const out: number[] = [];
  let t = 0;
  for (const h of r.stats.stepSizesS ?? []) out.push((t += h));
  return out;
};
const hasTime = (times: number[], t: number): boolean => times.some((x) => Math.abs(x - t) <= 1e-6);

describe("fire-zone run-level properties, part B", () => {
  // Feature: fire-zone, Property 10: Open fraction interpolation
  it("Property 10: vent table times and HRR table times are accepted-step times", () => {
    const arbCase = fc.record({
      base: arbSmall,
      ticks: fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 1, maxLength: 5 }),
      fracs: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 6, maxLength: 6 }),
    });
    fc.assert(
      fc.property(arbCase, ({ base, ticks, fracs }) => {
        const s = structuredClone(base);
        const room = s.compartments[0]!;
        const timesS = [0, ...ticks.sort((a, b) => a - b).map((n) => (n * s.durationS) / 1000)];
        s.vents = [
          {
            kind: "wall",
            id: "tv",
            from: room.id,
            to: "OUTSIDE",
            sillM: 0,
            soffitM: Math.min(1, room.heightM),
            widthM: 0.5,
            face: "front",
            offsetM: 0,
            open: { timesS, fractions: timesS.map((_, i) => fracs[i]!) },
          },
        ];
        const r = run(s);
        expect(r.status).toBe("ok");
        const steps = stepTimes(r);
        for (const t of timesS) if (t > 0 && t <= s.durationS) expect(hasTime(steps, t), `vent time ${t}`).toBe(true);
        for (const f of s.fires) {
          for (const row of f.table) {
            const t = (f.ignitionTimeS ?? 0) + row.timeS;
            if (t > 0 && t <= s.durationS) expect(hasTime(steps, t), `HRR time ${t}`).toBe(true);
          }
        }
      }),
    );
  }, TEST_TIMEOUT_MS);

  // Feature: fire-zone, Property 24: Determinism and no hidden state
  it("Property 24: run A, run B, run A, and a fresh module give identical Results", async () => {
    await fc.assert(
      fc.asyncProperty(arbSmall, arbSmall, async (a, b) => {
        const a1 = run(a);
        run(b);
        const a2 = run(a);
        expect(same(a1, a2)).toBe(true);
        expect(same(a1.warnings, a2.warnings)).toBe(true);
        expect(same(a1.stats.stepSizesS, a2.stats.stepSizesS)).toBe(true);
        vi.resetModules();
        const fresh = await import("../../src/core/fire");
        const a3 = fresh.runFire(structuredClone(a), { recordSteps: true });
        expect(same(a1, a3)).toBe(true);
      }),
    );
  }, TEST_TIMEOUT_MS);

  // Feature: fire-zone, Property 35: Upper plume argument order only matters for upper-layer burning
  it("Property 35: the plume argument order is bit-identical when nothing burns in the upper layer", () => {
    const withOrder = (s: Scenario, v: boolean): Scenario => ({
      ...structuredClone(s),
      options: { ...s.options, cfastUpperPlumeArgOrder: v },
    });
    fc.assert(
      fc.property(arbSmall, (s) => {
        const off = run(withOrder(s, false));
        const on = run(withOrder(s, true));
        expect(same(on, run(withOrder(s, true)))).toBe(true); // each setting is deterministic
        expect(same(off, run(withOrder(s, false)))).toBe(true);
        if (off.stats.maxUpperBurnHrrW === 0 && on.stats.maxUpperBurnHrrW === 0) {
          expect(same(off, on)).toBe(true);
        }
      }),
    );
  }, TEST_TIMEOUT_MS);

  // Feature: fire-zone, Property 36: A shaft is a single well-mixed zone
  it("Property 36: a shaft has Vu = V - VMIN, Tl = Tu and equal species fractions at every output time", () => {
    fc.assert(
      fc.property(arbSmall, (base) => {
        const s = structuredClone(base);
        s.compartments[0]!.kind = "shaft";
        const r = run(s, false);
        expect(r.status).toBe("ok");
        const c = r.compartments[0]!;
        const room = s.compartments[0]!;
        const volume = room.widthM * room.depthM * room.heightM;
        const vu = volume - minLayerVolumeM3(volume);
        for (let k = 0; k < r.timesS.length; k++) {
          expect(Math.abs(c.upperVolumeM3[k]! - vu)).toBeLessThanOrEqual(1e-9 * volume);
          expect(Math.abs(c.lowerTempK[k]! - c.upperTempK[k]!)).toBeLessThanOrEqual(1e-9 * c.upperTempK[k]!);
          for (const sp of ["o2", "co2", "co", "h2o", "soot"] as const) {
            expect(Math.abs(c.lower[sp][k]! - c.upper[sp][k]!), sp).toBeLessThanOrEqual(1e-9);
          }
        }
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("a corridor keeps a free interface (Property 36, counterpart)", () => {
    fc.assert(
      fc.property(arbSmall, (base) => {
        const s = structuredClone(base);
        s.compartments[0]!.kind = "corridor";
        s.fires = s.fires.map((f) => ({
          ...f,
          compartmentId: s.compartments[0]!.id,
          xM: 0.5 * s.compartments[0]!.widthM,
          yM: 0.5 * s.compartments[0]!.depthM,
          table: f.table.map((row) => ({ ...row, hrrW: 100_000 })),
        }));
        const r = run(s, false);
        expect(r.status).toBe("ok");
        const room = s.compartments[0]!;
        const volume = room.widthM * room.depthM * room.heightM;
        const vu = volume - minLayerVolumeM3(volume);
        const last = r.timesS.length - 1;
        expect(r.compartments[0]!.upperVolumeM3[last]!).toBeLessThan(vu);
      }),
    );
  }, TEST_TIMEOUT_MS);
});
