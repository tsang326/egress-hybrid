// Generators for fire-zone property tests (design, Testing Strategy > Generators).
// Every optional extension shrinks to its minimum, so counterexamples shrink toward
// one compartment, one fire with a two-row HRR table and no vents (Requirement 14.11).
import fc from "fast-check";
import type {
  Compartment,
  Fire,
  HrrRow,
  OpenFractionTable,
  Scenario,
  Surface,
  Vent,
} from "../../src/core/fire/types";

// Bounds from the design.
export const BOUNDS = {
  sideM: { min: 2, max: 8 },
  heightM: { min: 2, max: 4 },
  maxCompartments: 4,
  maxFloors: 3,
  durationS: { min: 5, max: 120 },
  hrrW: { min: 0, max: 500_000 },
  heatOfCombustionJPerKg: { min: 15e6, max: 50e6 },
} as const;

const RUN_TIME_LIMIT_MS = 10_000; // Requirement 14.9

// Default material: concrete-like single layer (generic estimate for tests only).
const defaultSurface = (): Surface => ({
  layers: [
    {
      name: "test-concrete",
      conductivityWPerMK: 1.75,
      densityKgPerM3: 2200,
      specificHeatJPerKgK: 1000,
      thicknessM: 0.15,
      emissivity: 0.94,
    },
  ],
});

const dim = (min: number, max: number) =>
  fc.integer({ min: Math.round(min * 10), max: Math.round(max * 10) }).map((n) => n / 10);

const hrrValue = fc
  .integer({ min: 0, max: BOUNDS.hrrW.max / 1000 })
  .map((kw) => kw * 1000);

/** Two or more rows with increasing times; shrinks to two rows. */
function arbTable(durationS: number): fc.Arbitrary<HrrRow[]> {
  const row = fc.record({
    hrrW: hrrValue,
    heightM: fc.constant(0.3),
    areaM2: fc.constant(0.5),
    coYield: fc.constant(0.01),
    sootYield: fc.constant(0.02),
  });
  return fc
    .tuple(row, row, fc.array(fc.tuple(fc.integer({ min: 1, max: 100 }), row), { maxLength: 3 }))
    .map(([first, second, extra]) => {
      const rows: HrrRow[] = [{ timeS: 0, ...first }];
      let t = durationS / 2;
      rows.push({ timeS: t, ...second });
      for (const [step, r] of extra) {
        t += (step * durationS) / 200;
        rows.push({ timeS: t, ...r });
      }
      return rows;
    });
}

function arbFire(compartments: Compartment[], index: number, durationS: number): fc.Arbitrary<Fire> {
  return fc
    .record({
      compIdx: fc.nat({ max: compartments.length - 1 }),
      fx: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      fy: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      radiativeFraction: fc.constantFrom(0.35, 0.3, 0.4),
      heatOfCombustionJPerKg: fc
        .integer({ min: 15, max: 50 })
        .map((m) => m * 1e6),
      table: arbTable(durationS),
    })
    .map((f) => {
      const c = compartments[f.compIdx]!;
      return {
        id: `fire${index}`,
        compartmentId: c.id,
        xM: f.fx * c.widthM,
        yM: f.fy * c.depthM,
        radiativeFraction: f.radiativeFraction,
        // Methane-like fuel (C1 H4); estimate for tests only.
        fuel: { c: 1, h: 4, o: 0, n: 0, cl: 0, heatOfCombustionJPerKg: f.heatOfCombustionJPerKg },
        table: f.table,
      };
    });
}

function arbOpen(durationS: number): fc.Arbitrary<number | OpenFractionTable> {
  const table = fc
    .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(
      ([a, b]): OpenFractionTable => ({ timesS: [0, durationS / 2], fractions: [a, b] }),
    );
  return fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true }), table);
}

function arbWallVent(
  compartments: Compartment[],
  index: number,
  durationS: number,
): fc.Arbitrary<Vent> {
  const ids = [...compartments.map((c) => c.id), "OUTSIDE"];
  return fc
    .record({
      a: fc.nat({ max: compartments.length - 1 }),
      b: fc.nat({ max: ids.length - 1 }),
      sill: fc.double({ min: 0, max: 0.5, noNaN: true }),
      height: fc.double({ min: 0.5, max: 1.5, noNaN: true }),
      width: fc.double({ min: 0.3, max: 1.5, noNaN: true }),
      face: fc.constantFrom("front", "back", "left", "right" as const),
      open: arbOpen(durationS),
    })
    .filter((v) => ids[v.b] !== compartments[v.a]!.id)
    // Requirement 4.10: the vent span (absolute elevation) must overlap the other room's height range.
    .filter((v) => {
      const from = compartments[v.a]!;
      const to = compartments.find((c) => c.id === ids[v.b]);
      if (to === undefined) return true; // OUTSIDE
      const soffit = Math.min(v.sill + v.height, from.heightM);
      const lo = from.floorElevationM + v.sill;
      const hi = from.floorElevationM + soffit;
      return lo < to.floorElevationM + to.heightM && hi > to.floorElevationM;
    })
    .map((v): Vent => {
      const from = compartments[v.a]!;
      // Keep the vent inside the room: soffit below the ceiling, width inside the wall.
      const soffit = Math.min(v.sill + v.height, from.heightM);
      const wallLen = v.face === "front" || v.face === "back" ? from.widthM : from.depthM;
      const width = Math.min(v.width, wallLen);
      return {
        kind: "wall",
        id: `vent${index}`,
        from: from.id,
        to: ids[v.b]!,
        sillM: v.sill,
        soffitM: soffit,
        widthM: width,
        face: v.face,
        offsetM: 0,
        open: v.open,
      };
    });
}

export interface ArbScenarioOptions {
  maxCompartments?: number;
  maxFloors?: number;
  maxFires?: number;
  maxVents?: number;
}

/** A valid Scenario within the design bounds. */
export function arbScenario(opts: ArbScenarioOptions = {}): fc.Arbitrary<Scenario> {
  const maxComp = Math.min(opts.maxCompartments ?? BOUNDS.maxCompartments, BOUNDS.maxCompartments);
  const maxFloors = Math.min(opts.maxFloors ?? BOUNDS.maxFloors, BOUNDS.maxFloors);
  const maxFires = opts.maxFires ?? 2;
  const maxVents = opts.maxVents ?? 4;

  const arbComp = fc.record({
    w: dim(BOUNDS.sideM.min, BOUNDS.sideM.max),
    d: dim(BOUNDS.sideM.min, BOUNDS.sideM.max),
    h: dim(BOUNDS.heightM.min, BOUNDS.heightM.max),
    floor: fc.nat({ max: maxFloors - 1 }),
  });

  return fc
    .record({
      durationS: fc.integer({ min: BOUNDS.durationS.min, max: BOUNDS.durationS.max }),
      printDiv: fc.constantFrom(1, 2, 5),
      comps: fc.array(arbComp, { minLength: 1, maxLength: maxComp }),
      extraFires: fc.integer({ min: 0, max: Math.max(0, maxFires - 1) }),
      ventCount: fc.integer({ min: 0, max: maxVents }),
    })
    .chain((g) => {
      // Compartments on higher floors sit above 4 m storeys (max room height).
      const compartments: Compartment[] = g.comps.map((c, i) => ({
        id: `c${i}`,
        widthM: c.w,
        depthM: c.d,
        heightM: c.h,
        floorElevationM: c.floor * BOUNDS.heightM.max,
        kind: "room",
        ceiling: defaultSurface(),
        floor: defaultSurface(),
        walls: defaultSurface(),
      }));
      const fires = fc.tuple(
        ...Array.from({ length: 1 + g.extraFires }, (_, i) => arbFire(compartments, i, g.durationS)),
      );
      const vents = fc.tuple(
        ...Array.from({ length: g.ventCount }, (_, i) => arbWallVent(compartments, i, g.durationS)),
      );
      return fc.record({ fires, vents }).map(
        ({ fires: f, vents: v }): Scenario => ({
          schemaVersion: 1,
          durationS: g.durationS,
          printIntervalS: Math.max(1, g.durationS / (g.printDiv * 10)),
          seed: 1,
          ambient: {
            interiorTempK: 293.15,
            exteriorTempK: 293.15,
            pressurePa: 101325,
            // Dry air mass fractions; standard composition.
            species: { o2: 0.2314, co2: 0.0005, co: 0, h2o: 0.0065, soot: 0 },
          },
          compartments,
          vents: v,
          fires: f,
        }),
      );
    });
}

// ---------------------------------------------------------------------------
// Defects (Property 1)
// ---------------------------------------------------------------------------

export interface Defect {
  name: string;
  /** Field or entity the validator warning must name. */
  field: string;
  apply: (s: Scenario) => Scenario;
}

const clone = (s: Scenario): Scenario => structuredClone(s);

const DEFECTS: Defect[] = [
  {
    name: "non-positive compartment width",
    field: "compartments[0].widthM",
    apply: (s) => {
      const c = clone(s);
      c.compartments[0]!.widthM = 0;
      return c;
    },
  },
  {
    name: "non-finite compartment height",
    field: "compartments[0].heightM",
    apply: (s) => {
      const c = clone(s);
      c.compartments[0]!.heightM = Infinity;
      return c;
    },
  },
  {
    name: "emissivity above 1",
    field: "compartments[0].walls",
    apply: (s) => {
      const c = clone(s);
      const w = c.compartments[0]!.walls;
      if ("layers" in w) w.layers[0]!.emissivity = 1.5;
      return c;
    },
  },
  {
    name: "surface with neither material nor adiabatic marker",
    field: "compartments[0].ceiling",
    apply: (s) => {
      const c = clone(s);
      c.compartments[0]!.ceiling = {} as never;
      return c;
    },
  },
  {
    name: "non-positive conductivity",
    field: "compartments[0].floor",
    apply: (s) => {
      const c = clone(s);
      const f = c.compartments[0]!.floor;
      if ("layers" in f) f.layers[0]!.conductivityWPerMK = -1;
      return c;
    },
  },
  {
    name: "unknown vent compartment",
    field: "vents[bad-vent]",
    apply: (s) => {
      const c = clone(s);
      c.vents.push({
        kind: "wall",
        id: "bad-vent",
        from: "no-such-compartment",
        to: "OUTSIDE",
        sillM: 0,
        soffitM: 1,
        widthM: 1,
        face: "front",
        offsetM: 0,
        open: 1,
      });
      return c;
    },
  },
  {
    name: "vent soffit above the ceiling",
    field: "vents[bad-vent]",
    apply: (s) => {
      const c = clone(s);
      const room = c.compartments[0]!;
      c.vents.push({
        kind: "wall",
        id: "bad-vent",
        from: room.id,
        to: "OUTSIDE",
        sillM: 0,
        soffitM: room.heightM + 1,
        widthM: 1,
        face: "front",
        offsetM: 0,
        open: 1,
      });
      return c;
    },
  },
  {
    name: "open-fraction table with decreasing times",
    field: "vents[bad-vent]",
    apply: (s) => {
      const c = clone(s);
      const room = c.compartments[0]!;
      c.vents.push({
        kind: "wall",
        id: "bad-vent",
        from: room.id,
        to: "OUTSIDE",
        sillM: 0,
        soffitM: Math.min(1, room.heightM),
        widthM: 1,
        face: "front",
        offsetM: 0,
        open: { timesS: [10, 0], fractions: [0, 1] },
      });
      return c;
    },
  },
  {
    name: "HRR table with one row",
    field: "fires[0].table",
    apply: (s) => {
      const c = clone(s);
      c.fires[0]!.table = c.fires[0]!.table.slice(0, 1);
      return c;
    },
  },
  {
    name: "negative HRR",
    field: "fires[0].table",
    apply: (s) => {
      const c = clone(s);
      c.fires[0]!.table[0]!.hrrW = -1;
      return c;
    },
  },
  {
    name: "fire outside its compartment",
    field: "fires[0]",
    apply: (s) => {
      const c = clone(s);
      const room = c.compartments.find((r) => r.id === c.fires[0]!.compartmentId)!;
      c.fires[0]!.xM = room.widthM + 1;
      return c;
    },
  },
  {
    name: "missing ambient species",
    field: "ambient.species",
    apply: (s) => {
      const c = clone(s);
      delete (c.ambient.species as Partial<Scenario["ambient"]["species"]>).o2;
      return c;
    },
  },
  {
    name: "non-positive print interval",
    field: "printIntervalS",
    apply: (s) => {
      const c = clone(s);
      c.printIntervalS = 0;
      return c;
    },
  },
  {
    name: "NaN duration",
    field: "durationS",
    apply: (s) => {
      const c = clone(s);
      c.durationS = NaN;
      return c;
    },
  },
];

/** One defect from the Property 1 list, as a function that edits a valid Scenario. */
export const arbDefect: fc.Arbitrary<Defect> = fc.constantFrom(...DEFECTS);

// ---------------------------------------------------------------------------
// Flow networks (Properties 9 and 19)
// ---------------------------------------------------------------------------

export const SPECIES_NAMES = ["o2", "co2", "co", "h2o", "soot", "n2", "uhc"] as const;
export type SpeciesName = (typeof SPECIES_NAMES)[number];

export interface FlowNetwork {
  /** Layer masses in kg, one entry per species per layer. Layers are nodes 0..n-1. */
  layerMassKg: Record<SpeciesName, number>[];
  /** Mass flows in kg/s from layer `from` to layer `to`; `to === -1` is the exterior. */
  flows: { from: number; to: number; massKgS: number }[];
  /** Species source rates in kg/s into each layer. */
  sourcesKgS: Record<SpeciesName, number>[];
  stepS: number;
}

const arbSpeciesRecord = (max: number): fc.Arbitrary<Record<SpeciesName, number>> =>
  fc.record({
    o2: fc.double({ min: 0, max, noNaN: true }),
    co2: fc.double({ min: 0, max, noNaN: true }),
    co: fc.double({ min: 0, max, noNaN: true }),
    h2o: fc.double({ min: 0, max, noNaN: true }),
    soot: fc.double({ min: 0, max, noNaN: true }),
    n2: fc.double({ min: 0, max, noNaN: true }),
    uhc: fc.double({ min: 0, max, noNaN: true }),
  });

/** Random layer graph: 2 to 8 layers, up to 12 flows (some to the exterior). */
export const arbFlowNetwork: fc.Arbitrary<FlowNetwork> = fc
  .integer({ min: 2, max: 8 })
  .chain((n) =>
    fc.record({
      layerMassKg: fc.array(arbSpeciesRecord(50), { minLength: n, maxLength: n }),
      flows: fc.array(
        fc
          .record({
            from: fc.nat({ max: n - 1 }),
            to: fc.integer({ min: -1, max: n - 1 }),
            massKgS: fc.double({ min: 0, max: 2, noNaN: true }),
          })
          .filter((f) => f.from !== f.to),
        { maxLength: 12 },
      ),
      sourcesKgS: fc.array(arbSpeciesRecord(0.1), { minLength: n, maxLength: n }),
      stepS: fc.double({ min: 0.01, max: 5, noNaN: true }),
    }),
  );

// ---------------------------------------------------------------------------
// Time limit (Requirement 14.9)
// ---------------------------------------------------------------------------

/**
 * Run `fn` and throw if it took longer than the limit (default 10 s). A synchronous
 * run cannot be interrupted, so the check happens after it returns; the thrown error
 * makes the property fail and shrink like any other counterexample.
 */
export function withTimeLimit<T>(
  fn: () => T,
  limitMs: number = RUN_TIME_LIMIT_MS,
  now: () => number = () => performance.now(),
): T {
  const start = now();
  const value = fn();
  const elapsedMs = now() - start;
  if (elapsedMs > limitMs) {
    throw new Error(`run took ${Math.round(elapsedMs)} ms, limit is ${limitMs} ms`);
  }
  return value;
}
