// Run-level property tests, part A (tasks.md 10.3): Properties 2, 6, 12, 13, 22 and 23, plus a unit test for a
// throwing physics function. Scenarios are small (at most 2 compartments, 2 floors, 20 s) so every run is far
// below the 10 s limit of Requirement 14.9.
// Failures are forced through vi.mock wrappers that pass through to the real code until a call counter reaches
// a threshold. With no threshold set they change nothing.
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result, Scenario } from "../../src/core/fire/types";
import { runFire } from "../../src/core/fire";
import { ambientPressureAtPa } from "../../src/core/fire/gas/ambient";
import { arbScenario, withTimeLimit } from "./arbitraries";

const NUM_RUNS = 100;
const TEST_TIMEOUT_MS = 300_000; // 100 runs of up to a few hundred ms each; each run is also held to 10 s by withTimeLimit
/**
 * Only the t = 0 sample and the flags matter: stop the run at 0.05 s. Shafts and vents with the same gas density on both
 * sides over their whole height currently need very small steps (see the note at RAISED_SILL_M), so a longer run
 * would test solver speed, not the property.
 */
const firstSecond = (s: Scenario): Scenario => ({ ...s, durationS: 0.05, printIntervalS: 0.05 });

const hooks = vi.hoisted(() => ({
  newtonFailFromCall: Infinity, // newtonSolve reports "not converged" from this call on
  newtonCalls: 0,
  hMinAtAdvance: Infinity, // the Nth ImplicitSolver.advance reports the H_MIN failure
  nanAtAdvance: Infinity, // after the Nth advance the state holds a NaN
  advanceCalls: 0,
  speciesFailAtCall: Infinity, // the Nth updateSpecies reports a species out of bounds
  speciesCalls: 0,
  throwAtEvaluate: Infinity, // the Nth driver-level evaluateModel throws
  evaluateCalls: 0,
}));

vi.mock("../../src/core/fire/solver/newton", async (orig) => {
  const m = await orig<typeof import("../../src/core/fire/solver/newton")>();
  return {
    ...m,
    newtonSolve: (args: Parameters<typeof m.newtonSolve>[0]) => {
      hooks.newtonCalls++;
      if (hooks.newtonCalls >= hooks.newtonFailFromCall) {
        return { converged: false, reason: "max-iterations", iterations: 0, matrixRebuilt: true, residualEvals: 0 };
      }
      return m.newtonSolve(args);
    },
  };
});

vi.mock("../../src/core/fire/solver/stepControl", async (orig) => {
  const m = await orig<typeof import("../../src/core/fire/solver/stepControl")>();
  class HookedSolver extends m.ImplicitSolver {
    override advance(tEnd: number, hMax?: number) {
      hooks.advanceCalls++;
      if (hooks.advanceCalls === hooks.hMinAtAdvance) return { ok: false as const, reason: "h-min" as const, t: this.t, h: 0 };
      const r = super.advance(tEnd, hMax);
      if (hooks.advanceCalls === hooks.nanAtAdvance) this.y[2] = Number.NaN;
      return r;
    }
  }
  return { ...m, ImplicitSolver: HookedSolver };
});

vi.mock("../../src/core/fire/species/tracker", async (orig) => {
  const m = await orig<typeof import("../../src/core/fire/species/tracker")>();
  return {
    ...m,
    updateSpecies: (...args: Parameters<typeof m.updateSpecies>) => {
      hooks.speciesCalls++;
      if (hooks.speciesCalls === hooks.speciesFailAtCall) {
        return { ok: false as const, failure: { node: 1, species: "o2" as const, fraction: 1.5 } };
      }
      return m.updateSpecies(...args);
    },
  };
});

vi.mock("../../src/core/fire/residual", async (orig) => {
  const m = await orig<typeof import("../../src/core/fire/residual")>();
  return {
    ...m,
    evaluateModel: (...args: Parameters<typeof m.evaluateModel>) => {
      hooks.evaluateCalls++;
      if (hooks.evaluateCalls === hooks.throwAtEvaluate) throw new Error("injected physics failure");
      return m.evaluateModel(...args);
    },
  };
});

function resetHooks(): void {
  hooks.newtonFailFromCall = Infinity;
  hooks.newtonCalls = 0;
  hooks.hMinAtAdvance = Infinity;
  hooks.nanAtAdvance = Infinity;
  hooks.advanceCalls = 0;
  hooks.speciesFailAtCall = Infinity;
  hooks.speciesCalls = 0;
  hooks.throwAtEvaluate = Infinity;
  hooks.evaluateCalls = 0;
}
beforeEach(resetHooks);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const small = (s: Scenario, maxDurationS = 5): Scenario => {
  const durationS = Math.min(s.durationS, maxDurationS);
  return { ...s, durationS, printIntervalS: Math.min(s.printIntervalS, durationS) };
};
// Wall vents are kept away from the floor (sill at least 0.3 m). A vent that starts at the floor with a small fire
// currently needs tens of thousands of solver steps per simulated second (reported with task 10.3; the 10 s limit is
// checked for all scenarios by Property 29 in task 10.5). These properties are about run bookkeeping, not that case.
const RAISED_SILL_M = 0.3;
const raiseSills = (s: Scenario): Scenario => ({
  ...s,
  vents: s.vents.map((v) => {
    if (v.kind !== "wall") return v;
    const from = s.compartments.find((c) => c.id === v.from)!;
    const sillM = Math.max(v.sillM, RAISED_SILL_M);
    return { ...v, sillM, soffitM: Math.min(Math.max(v.soffitM, sillM + 0.3), from.heightM) };
  }),
});
const arbSmall = arbScenario({ maxCompartments: 2, maxFloors: 2, maxFires: 1, maxVents: 2 }).map((s) => raiseSills(small(s)));

/** Every numeric array of a Result (not warnings or flags), in a fixed order. */
function numericParts(r: Result): Float64Array[] {
  const out: Float64Array[] = [r.timesS];
  const layer = (l: Result["compartments"][number]["upper"]) =>
    out.push(l.o2, l.co2, l.co, l.h2o, l.soot, l.opticalDensityPerM, l.visibilityM);
  for (const c of r.compartments) {
    out.push(c.upperTempK, c.lowerTempK, c.interfaceHeightM, c.pressurePa, c.upperVolumeM3);
    layer(c.upper);
    layer(c.lower);
    for (const b of c.burnedHrrW) out.push(b.values);
  }
  for (const v of r.vents) {
    for (const e of v.ends) out.push(e.upperInKgS, e.upperOutKgS, e.lowerInKgS, e.lowerOutKgS);
    out.push(v.openFraction);
  }
  return out;
}
const sameBits = (a: Float64Array, b: Float64Array): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const identicalNumbers = (a: Result, b: Result): boolean => {
  const pa = numericParts(a);
  const pb = numericParts(b);
  return pa.length === pb.length && pa.every((x, i) => sameBits(x, pb[i] as Float64Array)) && a.stats.steps === b.stats.steps;
};
/** `part` holds the first part.length values of `full` (bit-identical). */
const isPrefix = (part: Float64Array, full: Float64Array): boolean =>
  part.length <= full.length && part.every((x, i) => Object.is(x, full[i]));
const prefixOfAll = (part: Result, full: Result): boolean => {
  const pa = numericParts(part);
  const pb = numericParts(full);
  return pa.length === pb.length && pa.every((x, i) => isPrefix(x, pb[i] as Float64Array));
};
const near = (a: number, b: number, rel = 1e-9): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------------------------

const STATUSES = ["ok", "invalid", "failed"];

// Values that are wrong in type or extreme in size. Huge finite numbers are left out of the two time fields only,
// because a valid duration of 1e9 s is a legitimate (very long) run, not a defect.
const weird = fc.oneof(
  fc.constant(Number.NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constantFrom(0, -1, 1e300, -1e300, 5e-324, 1e-9),
  fc.constantFrom("x", "", null, undefined, true, false),
  fc.constantFrom<unknown>([], {}, [1, 2, 3], { a: 1 }, [null], [{}]),
);
const weirdTime = fc.oneof(
  fc.constant(Number.NaN),
  fc.constant(-Infinity),
  fc.constantFrom(0, -1),
  fc.constantFrom("x", null, undefined, true, [], {}),
);

const TOP_KEYS = ["schemaVersion", "title", "seed", "ambient", "options", "compartments", "vents", "fires", "unsupported"];
const COMP_KEYS = ["id", "widthM", "depthM", "heightM", "floorElevationM", "kind", "isStair", "ceiling", "floor", "walls", "leakage"];
const FIRE_KEYS = ["id", "compartmentId", "xM", "yM", "radiativeFraction", "ignitionTimeS", "fuel", "table"];

/** A valid small Scenario with 1 to 3 fields replaced by wrong-type or extreme values. */
const arbDamaged: fc.Arbitrary<unknown> = fc
  .record({
    s: arbSmall,
    edits: fc.array(
      fc.record({
        where: fc.constantFrom("top", "comp", "fire", "time"),
        key: fc.nat({ max: 20 }),
        value: weird,
        timeValue: weirdTime,
        delete: fc.boolean(),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  })
  .map(({ s, edits }) => {
    const copy = structuredClone(s) as unknown as Record<string, unknown>;
    for (const e of edits) {
      let target: unknown = copy;
      let keys = TOP_KEYS;
      if (e.where === "comp" || e.where === "fire") {
        const list = copy[e.where === "comp" ? "compartments" : "fires"];
        target = Array.isArray(list) ? list[0] : undefined;
        keys = e.where === "comp" ? COMP_KEYS : FIRE_KEYS;
      }
      // An earlier edit may have replaced the list itself; then this edit has nothing to change.
      if (typeof target !== "object" || target === null) continue;
      const key = e.where === "time" ? (e.key % 2 === 0 ? "durationS" : "printIntervalS") : (keys[e.key % keys.length] as string);
      const obj = target as Record<string, unknown>;
      if (e.delete) delete obj[key];
      else obj[key] = e.where === "time" ? e.timeValue : e.value;
    }
    return copy;
  });

const arbObject: fc.Arbitrary<unknown> = fc.oneof(
  fc.object({ maxDepth: 3 }),
  fc.object({ key: fc.constantFrom(...TOP_KEYS, "durationS", "printIntervalS"), values: [weird, fc.integer(), fc.string()], maxDepth: 2 }),
  fc.constant({}),
);
const arbNonObject: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.boolean(),
  fc.bigInt(),
  fc.array(fc.anything(), { maxLength: 3 }),
  fc.constant(() => 1),
);

describe("Property 2: runFire never throws for object input", () => {
  // Feature: fire-zone, Property 2: runFire never throws for object input
  // **Validates: Requirements 1.11, 10.8, 11.6**
  it("returns ok, invalid or failed for object-shaped values", () => {
    fc.assert(
      fc.property(fc.oneof(arbObject, arbDamaged), (input) => {
        const r = withTimeLimit(() => runFire(input as Scenario));
        expect(STATUSES).toContain(r.status);
        expect(Array.isArray(r.warnings)).toBe(true);
        if (r.status === "invalid") expect(r.timesS.length).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);

  it("throws a TypeError for values that are not objects", () => {
    fc.assert(
      fc.property(arbNonObject, (input) => {
        expect(() => runFire(input as Scenario)).toThrow(TypeError);
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);

  it("returns a Result when a property getter throws", () => {
    const base = structuredClone(small((fc.sample(arbSmall, 1)[0]) as Scenario)) as unknown as Record<string, unknown>;
    Object.defineProperty(base, "compartments", {
      enumerable: true,
      get() {
        throw new TypeError("getter failure");
      },
    });
    const r = runFire(base as unknown as Scenario);
    expect(STATUSES).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------------------------

const arbKinds = fc.array(fc.constantFrom("room", "corridor", "shaft"), { minLength: 2, maxLength: 2 });

describe("Property 6: Initial sample equals ambient", () => {
  // Feature: fire-zone, Property 6: Initial sample equals ambient
  // **Validates: Requirements 3.5, 8.2, 8.9**
  it("the t = 0 sample holds the ambient state of every compartment", () => {
    fc.assert(
      fc.property(arbSmall, arbKinds, (s0, kinds) => {
        const s: Scenario = firstSecond({
          ...s0,
          compartments: s0.compartments.map((c, i) => ({ ...c, kind: kinds[i] as "room" | "corridor" | "shaft" })),
        });
        const r = withTimeLimit(() => runFire(s));
        expect(r.status).not.toBe("invalid");
        expect(r.timesS.length).toBeGreaterThanOrEqual(1);
        expect(r.timesS[0]).toBe(0);
        const a = s.ambient;
        s.compartments.forEach((c, i) => {
          const series = r.compartments[i]!;
          expect(near(series.upperTempK[0]!, a.interiorTempK)).toBe(true);
          expect(near(series.lowerTempK[0]!, a.interiorTempK)).toBe(true);
          const p = ambientPressureAtPa(c.floorElevationM, a.pressurePa, a.exteriorTempK);
          expect(near(series.pressurePa[0]!, p)).toBe(true);
          const volume = c.widthM * c.depthM * c.heightM;
          const vmin = Math.min(1e-4 * volume, 1); // Requirement 3.5 as amended: VMIN = min(1e-4 V, 1 m3)
          const area = c.widthM * c.depthM;
          const expectedVu = c.kind === "shaft" ? volume - vmin : vmin;
          expect(near(series.upperVolumeM3[0]!, expectedVu)).toBe(true);
          expect(near(series.interfaceHeightM[0]!, c.heightM - expectedVu / area)).toBe(true);
          for (const layer of [series.upper, series.lower]) {
            expect(near(layer.o2[0]!, a.species.o2)).toBe(true);
            expect(near(layer.co2[0]!, a.species.co2)).toBe(true);
            expect(near(layer.co[0]!, a.species.co)).toBe(true);
            expect(near(layer.h2o[0]!, a.species.h2o)).toBe(true);
            expect(layer.soot[0]).toBe(a.species.soot);
            expect(layer.opticalDensityPerM[0]).toBe(0); // zero ambient soot: Requirement 8.6
            expect(layer.visibilityM[0]).toBe(Infinity);
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------------------------

const arbFlagScenario = fc
  .record({
    s: arbSmall,
    marks: fc.array(fc.record({ kind: fc.constantFrom("room", "corridor", "shaft"), isStair: fc.boolean() }), {
      minLength: 2,
      maxLength: 2,
    }),
    // Ceiling/floor vents: between the two stacked compartments, or through the roof of the top one.
    cfVents: fc.array(fc.constantFrom("between", "roof"), { maxLength: 2 }),
  })
  .map(({ s, marks, cfVents }): Scenario => {
    // Stack the compartments: c1 sits on c0, so a ceiling/floor vent between them joins real neighbours.
    const compartments = s.compartments.map((c, i) => ({
      ...c,
      floorElevationM: i === 0 ? 0 : (s.compartments[0] as Scenario["compartments"][number]).heightM,
      kind: (marks[i] as { kind: "room" | "corridor" | "shaft" }).kind,
      ...((marks[i] as { isStair: boolean }).isStair ? { isStair: true } : {}),
    }));
    const top = compartments[compartments.length - 1]!.id;
    const extra = cfVents
      .filter((where) => where === "roof" || compartments.length === 2)
      .map((where, i) => ({
        kind: "ceilingFloor" as const,
        id: `cf${i}`,
        lower: where === "roof" ? top : compartments[0]!.id,
        upper: where === "roof" ? "OUTSIDE" : compartments[1]!.id,
        areaM2: 0.25,
        shape: "square" as const,
        open: 1,
      }));
    return firstSecond({ ...s, compartments, vents: [...s.vents, ...extra] });
  });

describe("Property 12: Stair and shaft flags", () => {
  // Feature: fire-zone, Property 12: Stair and shaft flags
  // **Validates: Requirements 5.7, 5.8**
  it("flags exactly the marked compartments and the vents that touch a stair or shaft", () => {
    fc.assert(
      fc.property(arbFlagScenario, (s) => {
        const r = withTimeLimit(() => runFire(s));
        // Independent oracle. Compartments: corridor, shaft or stair. Vents: any vent with an end in a stair or shaft
        // compartment (Requirement 5.7: the value depends on a Stair_Compartment).
        const special = new Set(s.compartments.filter((c) => c.kind === "shaft" || c.isStair === true).map((c) => c.id));
        const expected = new Set<string>();
        for (const c of s.compartments) if (c.kind !== "room" || c.isStair === true) expected.add(`compartment:${c.id}`);
        for (const v of s.vents) {
          const ends = v.kind === "wall" ? [v.from, v.to] : v.kind === "ceilingFloor" ? [v.lower, v.upper] : [v.compartmentId];
          if (ends.some((e) => special.has(e))) expected.add(`vent:${v.id}`);
        }
        const got = r.flags.map((f) => `${f.target.kind}:${f.target.id}`);
        expect(new Set(got).size).toBe(got.length);
        expect(new Set(got)).toEqual(expected);
        for (const f of r.flags) {
          const w = r.warnings[f.warningIndex]!;
          expect(w.code).toBe("STAIR_OR_SHAFT_LIMIT");
          expect(w.source).toBe("Tech Ref 1.5");
          expect(w.location.id).toBe(f.target.id);
          expect(f.quantities).toBe("all");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------------------------

const arbUnsupported = fc.array(fc.constantFrom("hvac", "sprinkler", "detector", "suppression", "target"), {
  minLength: 1,
  maxLength: 5,
});

describe("Property 13: Unsupported items are ignored", () => {
  // Feature: fire-zone, Property 13: Unsupported items are ignored
  // **Validates: Requirements 5.9, 6.12**
  it("adds one warning per item and leaves every number unchanged", () => {
    fc.assert(
      fc.property(arbSmall, arbUnsupported, (s, kinds) => {
        const withItems: Scenario = { ...s, unsupported: kinds.map((kind, i) => ({ kind, id: `u${i}` })) };
        const base = withTimeLimit(() => runFire(s));
        const added = withTimeLimit(() => runFire(withItems));
        expect(added.status).toBe(base.status);
        expect(identicalNumbers(added, base)).toBe(true);
        const items = added.warnings.filter((w) => w.code === "UNSUPPORTED_ITEM");
        expect(items.length).toBe(kinds.length);
        expect(base.warnings.some((w) => w.code === "UNSUPPORTED_ITEM")).toBe(false);
        expect(added.warnings.length).toBe(base.warnings.length + kinds.length);
        expect(added.warnings.filter((w) => w.code !== "UNSUPPORTED_ITEM")).toEqual(base.warnings);
        expect(added.flags.map((f) => f.target)).toEqual(base.flags.map((f) => f.target));
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------------------------

type Forced = "newton" | "hmin" | "nan" | "species";
const FORCED_CODE: Record<Forced, string> = {
  newton: "SOLVER_STEP_TOO_SMALL",
  hmin: "SOLVER_STEP_TOO_SMALL",
  nan: "NON_FINITE_STATE",
  species: "SPECIES_OUT_OF_RANGE",
};

describe("Property 22: Failure keeps earlier samples", () => {
  // Feature: fire-zone, Property 22: Failure keeps earlier samples
  // **Validates: Requirements 8.8, 9.6, 10.9, 11.5**
  it("a forced failure gives status failed, a naming warning and bit-identical earlier samples", () => {
    fc.assert(
      fc.property(arbSmall, fc.constantFrom<Forced>("newton", "hmin", "nan", "species"), fc.double({ min: 0, max: 1, noNaN: true }), (s, kind, u) => {
        resetHooks();
        const full = withTimeLimit(() => runFire(s));
        fc.pre(full.status === "ok"); // the property is about forced failures; an unforced failure is Property 29's concern
        const total = { newton: hooks.newtonCalls, hmin: hooks.advanceCalls, nan: hooks.advanceCalls, species: hooks.speciesCalls }[kind];
        expect(total).toBeGreaterThanOrEqual(1);
        const n = 1 + Math.min(total - 1, Math.floor(u * total)); // the failing call, 1 to total
        resetHooks();
        if (kind === "newton") hooks.newtonFailFromCall = n;
        if (kind === "hmin") hooks.hMinAtAdvance = n;
        if (kind === "nan") hooks.nanAtAdvance = n;
        if (kind === "species") hooks.speciesFailAtCall = n;
        const failed = withTimeLimit(() => runFire(s));
        resetHooks();

        expect(failed.status).toBe("failed");
        const w = failed.warnings.filter((x) => x.code === FORCED_CODE[kind]);
        expect(w.length).toBe(1);
        const tf = w[0]!.timeS;
        expect(tf).not.toBeNull();
        expect(Number.isFinite(tf)).toBe(true);
        // Earlier samples are kept and identical to the unforced run; the failure removes at least the last one.
        expect(failed.timesS.length).toBeGreaterThanOrEqual(1);
        expect(failed.timesS.length).toBeLessThan(full.timesS.length);
        expect(prefixOfAll(failed, full)).toBe(true);
        expect(failed.timesS[failed.timesS.length - 1]!).toBeLessThanOrEqual(tf as number);
        expect(tf as number).toBeLessThanOrEqual(s.durationS);
        // Every series was trimmed to the same length.
        for (const part of numericParts(failed)) expect(part.length).toBe(failed.timesS.length);
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------------------------

const arbOutputScenario = fc
  .record({ s: arbScenario({ maxCompartments: 1, maxFloors: 1, maxFires: 1, maxVents: 1 }), duration: fc.integer({ min: 3, max: 35 }), frac: fc.double({ min: 0.05, max: 1, noNaN: true }), clockStepMs: fc.constantFrom(0, 40, 300, 1500) })
  .map(({ s, duration, frac, clockStepMs }) => {
    const printIntervalS = Math.max(0.1, Math.round(frac * duration * 10) / 10);
    const scenario = raiseSills({ ...s, durationS: duration, printIntervalS: Math.min(printIntervalS, duration) });
    return { scenario, clockStepMs };
  });

describe("Property 23: Output times and progress", () => {
  // Feature: fire-zone, Property 23: Output times and progress
  // **Validates: Requirements 10.2, 10.4, 10.5, 10.6**
  it("samples at k * interval plus the duration, and progress at least every 10 s", () => {
    fc.assert(
      fc.property(arbOutputScenario, ({ scenario: s, clockStepMs }) => {
        const events: { simTimeS: number; fraction: number }[] = [];
        let ticks = 0;
        const r = withTimeLimit(() =>
          runFire(s, {
            recordSteps: true,
            onProgress: (e) => events.push(e),
            now: () => (ticks++) * clockStepMs,
          }),
        );
        expect(r.status).toBe("ok");

        // Requirement 10.2: expected sample times.
        const expected: number[] = [];
        for (let k = 0; k * s.printIntervalS <= s.durationS; k++) expected.push(k * s.printIntervalS);
        if (s.durationS - (expected[expected.length - 1] as number) > 1e-9) expected.push(s.durationS);
        expect(Array.from(r.timesS)).toEqual(expected);

        // Requirement 10.4: each sample time is an accepted step end, within 1e-6 s.
        const ends: number[] = [0];
        for (const h of r.stats.stepSizesS as Float64Array) ends.push((ends[ends.length - 1] as number) + h);
        // The step sizes of a restart segment add up to the segment length, so compare sums with a small tolerance.
        let j = 0;
        for (const t of r.timesS) {
          while (j < ends.length - 1 && (ends[j] as number) < t - 1e-6) j++;
          expect(Math.abs((ends[j] as number) - t)).toBeLessThanOrEqual(1e-6);
        }

        // Requirements 10.5, 10.6.
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events[0]!.simTimeS).toBe(0);
        for (let i = 0; i < events.length; i++) {
          const e = events[i]!;
          expect(e.fraction).toBeGreaterThanOrEqual(0);
          expect(e.fraction).toBeLessThanOrEqual(1);
          if (i > 0) {
            const prev = events[i - 1]!;
            expect(e.fraction).toBeGreaterThanOrEqual(prev.fraction);
            expect(e.simTimeS).toBeGreaterThanOrEqual(prev.simTimeS);
            expect(e.simTimeS - prev.simTimeS).toBeLessThanOrEqual(10 + 1e-6);
          }
        }
        expect(events[events.length - 1]!.fraction).toBe(1);
        expect(events[events.length - 1]!.simTimeS).toBe(s.durationS);
      }),
      { numRuns: NUM_RUNS },
    );
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Unit test: a throwing physics function
// ---------------------------------------------------------------------------------------------

describe("an exception inside the physics", () => {
  it("gives INTERNAL_ERROR and keeps the samples taken before it", () => {
    const s = small(fc.sample(arbSmall, { seed: 7, numRuns: 1 })[0] as Scenario, 20);
    resetHooks();
    const full = runFire(s);
    expect(full.status).toBe("ok");
    expect(hooks.evaluateCalls).toBeGreaterThan(5);
    resetHooks();
    hooks.throwAtEvaluate = Math.max(3, Math.floor(full.stats.steps / 2)); // a driver-level evaluation after the t = 0 sample
    const r = runFire(s);
    resetHooks();
    expect(r.status).toBe("failed");
    const w = r.warnings.filter((x) => x.code === "INTERNAL_ERROR");
    expect(w.length).toBe(1);
    expect(w[0]!.message).toContain("injected physics failure");
    expect(r.timesS.length).toBeGreaterThanOrEqual(1);
    expect(r.timesS.length).toBeLessThan(full.timesS.length);
    expect(prefixOfAll(r, full)).toBe(true);
  });

  it("gives INTERNAL_ERROR with no samples when the first evaluation throws", () => {
    const s = small(fc.sample(arbSmall, { seed: 7, numRuns: 1 })[0] as Scenario, 20);
    hooks.throwAtEvaluate = 1;
    const r = runFire(s);
    resetHooks();
    expect(r.status).toBe("failed");
    expect(r.warnings.some((x) => x.code === "INTERNAL_ERROR")).toBe(true);
    expect(r.timesS.length).toBe(0);
  });
});
