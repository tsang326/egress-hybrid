// Unit tests for the Input_Validator (task 2.3).
// Requirements 1.11, 2.4, 2.8, 4.7, 5.9, 6.12, and the wall-vent bounds rule of validate/checks.ts.
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/fire/validate/validate";
import type { Compartment, Scenario, Vent, WallVent } from "../../src/core/fire/types";

const surface = () => ({
  layers: [
    {
      name: "test-concrete", // generic estimate for tests only
      conductivityWPerMK: 1.75,
      densityKgPerM3: 2200,
      specificHeatJPerKgK: 1000,
      thicknessM: 0.15,
      emissivity: 0.94,
    },
  ],
});

function room(id: string, widthM: number, depthM: number, heightM: number, floorElevationM = 0): Compartment {
  return {
    id,
    widthM,
    depthM,
    heightM,
    floorElevationM,
    kind: "room",
    ceiling: surface(),
    floor: surface(),
    walls: surface(),
  };
}

function base(vents: Vent[] = [], compartments: Compartment[] = [room("a", 4, 3, 2.5), room("b", 2, 2, 2.5)]): Scenario {
  return {
    schemaVersion: 1,
    durationS: 60,
    printIntervalS: 10,
    seed: 1,
    ambient: {
      interiorTempK: 293.15,
      exteriorTempK: 293.15,
      pressurePa: 101325,
      species: { o2: 0.2314, co2: 0.0005, co: 0, h2o: 0.0065, soot: 0 },
    },
    compartments,
    vents,
    fires: [
      {
        id: "f",
        compartmentId: "a",
        xM: 1,
        yM: 1,
        radiativeFraction: 0.3,
        fuel: { c: 1, h: 4, o: 0, n: 0, cl: 0, heatOfCombustionJPerKg: 5e7 },
        table: [
          { timeS: 0, hrrW: 0, heightM: 0.3, areaM2: 0.5, coYield: 0.01, sootYield: 0.02 },
          { timeS: 30, hrrW: 100000, heightM: 0.3, areaM2: 0.5, coYield: 0.01, sootYield: 0.02 },
        ],
      },
    ],
  };
}

const codes = (s: unknown) => validate(s).warnings.map((w) => w.code);

describe("validate: unit tests", () => {
  it("accepts a valid scenario with no warnings", () => {
    const r = validate(base());
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  // Requirement 2.4
  it("accepts an explicit adiabatic surface", () => {
    const s = base();
    s.compartments[0]!.walls = { adiabatic: true };
    const r = validate(s);
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.code)).not.toContain("SURFACE_MISSING");
  });

  it("rejects a surface with neither material nor adiabatic marker and names it", () => {
    const s = base();
    (s.compartments[0] as unknown as Record<string, unknown>)["ceiling"] = {};
    const r = validate(s);
    expect(r.valid).toBe(false);
    const w = r.warnings.find((x) => x.code === "SURFACE_MISSING");
    expect(w?.severity).toBe("error");
    expect(w?.location).toMatchObject({ id: "a", field: "ceiling" });
  });

  // Requirement 2.8
  it("reports a stacking mismatch as a warning and stays valid", () => {
    const comps = [room("lo", 4, 4, 2.5, 0), room("hi", 4, 4, 2.5, 3)]; // gap 0.5 m
    const vent: Vent = { kind: "ceilingFloor", id: "cv", lower: "lo", upper: "hi", areaM2: 1, shape: "square", open: 1 };
    const r = validate({ ...base([vent], comps), fires: base().fires.map((f) => ({ ...f, compartmentId: "lo" })) });
    const w = r.warnings.find((x) => x.code === "STACKING_MISMATCH");
    expect(w?.severity).toBe("warning");
    expect(r.valid).toBe(true);
  });

  it("does not warn when compartments stack within 0.01 m", () => {
    const comps = [room("lo", 4, 4, 2.5, 0), room("hi", 4, 4, 2.5, 2.505)];
    const vent: Vent = { kind: "ceilingFloor", id: "cv", lower: "lo", upper: "hi", areaM2: 1, shape: "square", open: 1 };
    const s = { ...base([vent], comps), fires: base().fires.map((f) => ({ ...f, compartmentId: "lo" })) };
    expect(codes(s)).not.toContain("STACKING_MISMATCH");
  });

  // Requirements 5.9, 6.12
  it("gives one warning per unsupported item, drops the list and stays valid", () => {
    const s: Scenario = {
      ...base(),
      unsupported: [
        { kind: "hvac", id: "fan1" },
        { kind: "sprinkler", id: "sp1" },
        { kind: "detector", id: "d1" },
        { kind: "suppression", id: "s1" },
        { kind: "target", id: "t1" },
      ],
    };
    const r = validate(s);
    const ws = r.warnings.filter((w) => w.code === "UNSUPPORTED_ITEM");
    expect(ws).toHaveLength(5);
    for (const w of ws) expect(w.severity).toBe("warning");
    expect(ws.map((w) => w.location.id)).toEqual(["fan1", "sp1", "d1", "s1", "t1"]);
    expect(r.valid).toBe(true);
    expect("unsupported" in r.scenario).toBe(false);
  });

  // Requirement 4.7
  describe("leakage area bounds (0, 100] m2", () => {
    const leak = (areaM2: number): Vent => ({ kind: "leakage", id: "lk", compartmentId: "a", areaM2, orientation: "wall" });
    it.each([0, -1, 100.0001, 1e6])("rejects %s", (area) => {
      const r = validate(base([leak(area)]));
      expect(r.valid).toBe(false);
      expect(r.warnings.map((w) => w.code)).toContain("LEAKAGE_AREA_INVALID");
    });
    it.each([1e-9, 0.5, 100])("accepts %s", (area) => {
      const r = validate(base([leak(area)]));
      expect(r.warnings.map((w) => w.code)).not.toContain("LEAKAGE_AREA_INVALID");
      expect(r.valid).toBe(true);
    });
  });

  // Requirement 1.11
  it.each([null, undefined, 42, "text", true, [], [1, 2]])("throws TypeError for non-object argument %j", (arg) => {
    expect(() => validate(arg)).toThrow(TypeError);
  });

  // Wall-vent bounds: offset + width are measured against the first compartment's wall only (CFAST convention).
  describe("wall vent bounds use the first compartment's wall", () => {
    const wallVent = (from: string, to: string, offsetM: number, widthM: number): WallVent => ({
      kind: "wall",
      id: "wv",
      from,
      to,
      sillM: 0,
      soffitM: 2,
      widthM,
      face: "front",
      offsetM,
      open: 1,
    });
    // a: 4 m wide front wall; b: 2 m wide front wall.

    it("accepts a vent that fits the first compartment's wall but is longer than the second one's", () => {
      const r = validate(base([wallVent("a", "b", 0.5, 3)]));
      expect(r.warnings.map((w) => w.code)).not.toContain("VENT_OUT_OF_BOUNDS");
      expect(r.valid).toBe(true);
    });

    it("rejects a vent that extends past the first compartment's wall even if the second is larger", () => {
      const r = validate(base([wallVent("b", "a", 0.5, 3)]));
      const w = r.warnings.find((x) => x.code === "VENT_OUT_OF_BOUNDS");
      expect(w?.location).toMatchObject({ id: "wv", field: "widthM" });
      expect(r.valid).toBe(false);
    });

    it("accepts a vent that ends exactly at the first compartment's wall end", () => {
      expect(codes(base([wallVent("a", "b", 1, 3)]))).not.toContain("VENT_OUT_OF_BOUNDS");
    });

    it("rejects a vent one millimetre past the first compartment's wall end", () => {
      expect(codes(base([wallVent("a", "b", 1, 3.001)]))).toContain("VENT_OUT_OF_BOUNDS");
    });
  });

  // Requirement 4.10
  describe("wall vent vertical overlap with the second compartment", () => {
    // "a" is a 2.5 m room on the ground floor; "up" is a 2.5 m room whose floor is at 3 m (3 to 5.5 m).
    const comps = [room("a", 4, 3, 2.5, 0), room("up", 4, 3, 2.5, 3)];
    const vent = (sillM: number, soffitM: number): WallVent => ({
      kind: "wall",
      id: "door",
      from: "a",
      to: "up",
      sillM,
      soffitM,
      widthM: 1,
      face: "front",
      offsetM: 0,
      open: 1,
    });

    it("rejects a vent that lies entirely below the second compartment and names the vent and both rooms", () => {
      const r = validate(base([vent(0, 2)], comps));
      const w = r.warnings.find((x) => x.code === "VENT_NO_VERTICAL_OVERLAP");
      expect(r.valid).toBe(false);
      expect(w?.location).toMatchObject({ kind: "vent", id: "door" });
      expect(w?.message).toContain('"door"');
      expect(w?.message).toContain('"a"');
      expect(w?.message).toContain('"up"');
    });

    it("rejects a vent that lies entirely above the second compartment", () => {
      const lowRoof = [room("a", 4, 3, 2.5, 0), room("up", 4, 3, 1, 0)];
      expect(codes(base([vent(1.5, 2.4)], lowRoof))).toContain("VENT_NO_VERTICAL_OVERLAP");
    });

    it("accepts a vent that partly overlaps the second compartment", () => {
      const lowRoof = [room("a", 4, 3, 2.5, 0), room("up", 4, 3, 1, 0)];
      const r = validate(base([vent(0.5, 1)], lowRoof));
      expect(r.warnings.map((w) => w.code)).not.toContain("VENT_NO_VERTICAL_OVERLAP");
      expect(r.valid).toBe(true);
    });
  });
});
