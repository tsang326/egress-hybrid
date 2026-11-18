// Checks for the shared generators and the fast-check global configuration
// (Requirements 14.9, 14.11, 14.12).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../src/core/fire/types";
import { arbDefect, arbFlowNetwork, arbScenario, BOUNDS, withTimeLimit } from "./arbitraries";

describe("fast-check global configuration", () => {
  it("a failing property reports seed and path for replay", () => {
    let message = "";
    try {
      fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), (n) => n < 10));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/seed: -?\d+/);
    expect(message).toMatch(/path: "[\d:]+"/);
    expect(message).toMatch(/Counterexample: \[10\]/); // shrunk
  });

  it("uses at least 100 runs", () => {
    let runs = 0;
    fc.assert(fc.property(fc.boolean(), () => void runs++));
    expect(runs).toBeGreaterThanOrEqual(100);
  });
});

describe("arbScenario", () => {
  it("stays within the design bounds", () => {
    fc.assert(
      fc.property(arbScenario(), (s) => {
        expect(s.compartments.length).toBeGreaterThanOrEqual(1);
        expect(s.compartments.length).toBeLessThanOrEqual(BOUNDS.maxCompartments);
        expect(s.durationS).toBeGreaterThanOrEqual(5);
        expect(s.durationS).toBeLessThanOrEqual(120);
        const elevations = new Set(s.compartments.map((c) => c.floorElevationM));
        expect(elevations.size).toBeLessThanOrEqual(BOUNDS.maxFloors);
        for (const c of s.compartments) {
          expect(c.widthM).toBeGreaterThanOrEqual(2);
          expect(c.widthM).toBeLessThanOrEqual(8);
          expect(c.depthM).toBeGreaterThanOrEqual(2);
          expect(c.depthM).toBeLessThanOrEqual(8);
          expect(c.heightM).toBeGreaterThanOrEqual(2);
          expect(c.heightM).toBeLessThanOrEqual(4);
        }
        for (const f of s.fires) {
          expect(f.table.length).toBeGreaterThanOrEqual(2);
          for (const r of f.table) {
            expect(r.hrrW).toBeGreaterThanOrEqual(0);
            expect(r.hrrW).toBeLessThanOrEqual(500_000);
          }
          const c = s.compartments.find((x) => x.id === f.compartmentId)!;
          expect(f.xM).toBeLessThanOrEqual(c.widthM);
          expect(f.yM).toBeLessThanOrEqual(c.depthM);
        }
      }),
    );
  });

  it("shrinks to one compartment, one fire with a two-row table, no vents", () => {
    const result = fc.check(
      fc.property(arbScenario(), () => false),
      { numRuns: 100, seed: 42 },
    );
    expect(result.failed).toBe(true);
    const s = result.counterexample![0] as Scenario;
    expect(s.compartments).toHaveLength(1);
    expect(s.fires).toHaveLength(1);
    expect(s.fires[0]!.table).toHaveLength(2);
    expect(s.vents).toHaveLength(0);
  });
});

describe("other generators and helpers", () => {
  it("arbDefect edits a valid scenario into a different one", () => {
    fc.assert(
      fc.property(arbScenario({ maxCompartments: 1 }), arbDefect, (s, d) => {
        const before = JSON.stringify(s);
        const edited = d.apply(s);
        expect(JSON.stringify(s)).toBe(before); // input not mutated
        expect(JSON.stringify(edited)).not.toBe(before);
      }),
    );
  });

  it("arbFlowNetwork makes valid graphs", () => {
    fc.assert(
      fc.property(arbFlowNetwork, (n) => {
        expect(n.layerMassKg.length).toBe(n.sourcesKgS.length);
        for (const f of n.flows) {
          expect(f.from).toBeGreaterThanOrEqual(0);
          expect(f.from).toBeLessThan(n.layerMassKg.length);
          expect(f.to).toBeLessThan(n.layerMassKg.length);
          expect(f.from).not.toBe(f.to);
        }
      }),
    );
  });

  it("withTimeLimit passes fast runs and fails slow ones", () => {
    expect(withTimeLimit(() => 7)).toBe(7);
    let t = 0;
    const clock = () => (t += 12_000);
    expect(() => withTimeLimit(() => 1, 10_000, clock)).toThrow(/limit is 10000 ms/);
  });
});
