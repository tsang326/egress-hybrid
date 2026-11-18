// Property tests for the Input_Validator (tasks.md 2.2).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/fire/validate/validate";
import type { Warning } from "../../src/core/fire/validate/warnings";
import type { Scenario } from "../../src/core/fire/types";
import { arbDefect, arbScenario } from "./arbitraries";
import type { Defect } from "./arbitraries";

const errorsOf = (s: unknown): Warning[] => validate(s).warnings.filter((w) => w.severity === "error");

// What the warning for each injected defect must look like: code plus the field or entity it names.
interface Expect {
  code: Warning["code"];
  matches: (loc: Warning["location"], s: Scenario, ventId: string) => boolean;
}

const EXPECTED: Record<string, Expect> = {
  "non-positive compartment width": {
    code: "INVALID_DIMENSION",
    matches: (l, s) => l.kind === "compartment" && l.id === s.compartments[0]!.id && l.field === "widthM",
  },
  "non-finite compartment height": {
    code: "NOT_FINITE",
    matches: (l) => l.field === "compartments[0].heightM",
  },
  "emissivity above 1": {
    code: "EMISSIVITY_RANGE",
    matches: (l) => l.kind === "material" && l.field === "layers[0].emissivity",
  },
  "surface with neither material nor adiabatic marker": {
    code: "SURFACE_MISSING",
    matches: (l, s) => l.id === s.compartments[0]!.id && l.field === "ceiling",
  },
  "non-positive conductivity": {
    code: "MATERIAL_INVALID",
    matches: (l) => l.kind === "material" && l.field === "layers[0].conductivityWPerMK",
  },
  "unknown vent compartment": {
    code: "VENT_COMPARTMENT_MISSING",
    matches: (l, _s, id) => l.kind === "vent" && l.id === id,
  },
  "vent soffit above the ceiling": {
    code: "VENT_OUT_OF_BOUNDS",
    matches: (l, _s, id) => l.kind === "vent" && l.id === id && l.field === "soffitM",
  },
  "open-fraction table with decreasing times": {
    code: "OPEN_TABLE_INVALID",
    matches: (l, _s, id) => l.kind === "vent" && l.id === id && l.field === "open",
  },
  "HRR table with one row": {
    code: "HRR_TABLE_INVALID",
    matches: (l, s) => l.kind === "fire" && l.id === s.fires[0]!.id && l.field === "table" && l.row === undefined,
  },
  "negative HRR": {
    code: "HRR_TABLE_INVALID",
    matches: (l, s) => l.kind === "fire" && l.id === s.fires[0]!.id && l.row === 0 && l.column === "hrrW",
  },
  "fire outside its compartment": {
    code: "FIRE_OUTSIDE_COMPARTMENT",
    matches: (l, s) => l.kind === "fire" && l.id === s.fires[0]!.id,
  },
  "missing ambient species": {
    code: "AMBIENT_SPECIES_MISSING",
    matches: (l) => l.field === "ambient.species.o2",
  },
  "non-positive print interval": {
    code: "PRINT_INTERVAL_INVALID",
    matches: (l) => l.field === "printIntervalS",
  },
  "NaN duration": {
    code: "NOT_FINITE",
    matches: (l) => l.field === "durationS",
  },
};

// A defect that makes a field unreadable hides checks that depend on that field. Such pairs are
// not independent defects, so they are not combined (the first defect is still reported).
const DEPENDENT_PAIRS: [string, string][] = [
  ["non-positive compartment width", "fire outside its compartment"],
  ["non-finite compartment height", "vent soffit above the ceiling"],
];
const independent = (names: string[]): boolean =>
  !DEPENDENT_PAIRS.some(([a, b]) => names.includes(a) && names.includes(b));

describe("Input_Validator properties", () => {
  // Feature: fire-zone, Property 1: Validator rejects every injected defect and names it
  // **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.2, 2.4, 2.7, 3.7, 4.4, 5.4, 6.2, 6.6, 7.6, 8.3, 10.3**
  it("Property 1: rejects every injected defect and names it", () => {
    fc.assert(
      fc.property(
        arbScenario(),
        fc.uniqueArray(arbDefect, { minLength: 1, maxLength: 6, selector: (d: Defect) => d.name }),
        (base, defects) => {
          fc.pre(independent(defects.map((d) => d.name)));
          // The valid base has no errors.
          expect(errorsOf(base)).toEqual([]);

          // Apply the defects one by one. Defects that add a vent all use the id "bad-vent",
          // so give each its own id to keep them independent (no duplicate-id error).
          let s = base;
          const ventIds: string[] = [];
          defects.forEach((d, i) => {
            const before = s.vents.length;
            s = d.apply(s);
            const id = `bad-vent-${i}`;
            if (s.vents.length > before) s.vents[s.vents.length - 1]!.id = id;
            ventIds.push(id);
          });

          const result = validate(s);
          const errors = result.warnings.filter((w) => w.severity === "error");
          expect(result.valid).toBe(false);
          // One error per defect: no more, no less (Req 1.10 collects all).
          expect(errors).toHaveLength(defects.length);
          const used = new Set<number>();
          defects.forEach((d, i) => {
            const exp = EXPECTED[d.name]!;
            const k = errors.findIndex(
              (w, j) => !used.has(j) && w.code === exp.code && exp.matches(w.location, base, ventIds[i]!),
            );
            expect(k, `no warning for defect "${d.name}"`).toBeGreaterThanOrEqual(0);
            used.add(k);
            expect(errors[k]!.message.length).toBeGreaterThan(0);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: fire-zone, Property 3: Size limits are exact
  // **Validates: Requirements 1.1, 1.4**
  describe("Property 3: size limits are exact", () => {
    const FLOOR_STEP_M = 4; // storeys far apart compared with the 0.01 m tolerance

    function sized(base: Scenario, c: number, floors: number, vents: number): Scenario {
      const s = structuredClone(base);
      const template = s.compartments[0]!;
      s.compartments = Array.from({ length: c }, (_, i) => ({
        ...structuredClone(template),
        id: `c${i}`,
        floorElevationM: (i % Math.max(1, floors)) * FLOOR_STEP_M,
      }));
      s.fires = s.fires.slice(0, 1).map((f) => ({ ...f, compartmentId: "c0", xM: 0.5, yM: 0.5 }));
      s.vents = Array.from({ length: vents }, (_, i) => ({
        kind: "leakage" as const,
        id: `leak${i}`,
        compartmentId: "c0",
        areaM2: 0.01,
        orientation: "wall" as const,
      }));
      return s;
    }

    const codes = (s: Scenario) => new Set(validate(s).warnings.map((w) => w.code));

    it("reports a limit violation if and only if c < 1, c > 30, f > 6 or v > 60", () => {
      fc.assert(
        fc.property(
          arbScenario({ maxCompartments: 1, maxVents: 0 }),
          fc.integer({ min: 0, max: 36 }),
          fc.integer({ min: 1, max: 9 }),
          fc.integer({ min: 0, max: 66 }),
          (base, c, floorsWanted, v) => {
            const floors = Math.min(floorsWanted, c); // no more floor levels than compartments
            const s = sized(base, c, floors, v);
            const got = codes(s);
            expect(got.has("LIMIT_COMPARTMENTS")).toBe(c < 1 || c > 30);
            expect(got.has("LIMIT_FLOORS")).toBe(floors > 6);
            expect(got.has("LIMIT_VENTS")).toBe(v > 60);
            if (c >= 1) {
              const violation = c > 30 || floors > 6 || v > 60;
              expect(validate(s).valid).toBe(!violation);
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    it("accepts 30 compartments, 6 floors and 60 vents, and rejects 31, 7 and 61", () => {
      fc.assert(
        fc.property(arbScenario({ maxCompartments: 1, maxVents: 0 }), (base) => {
          expect(validate(sized(base, 30, 6, 60)).valid).toBe(true);
          expect(codes(sized(base, 31, 6, 0))).toContain("LIMIT_COMPARTMENTS");
          expect(codes(sized(base, 30, 7, 0))).toContain("LIMIT_FLOORS");
          expect(codes(sized(base, 30, 6, 61))).toContain("LIMIT_VENTS");
          expect(validate(sized(base, 31, 6, 0)).valid).toBe(false);
          expect(validate(sized(base, 30, 7, 0)).valid).toBe(false);
          expect(validate(sized(base, 30, 6, 61)).valid).toBe(false);
        }),
      );
    });
  });
});
