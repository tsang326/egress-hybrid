// Property and unit tests for the vent modules (tasks.md 5.2).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ambientDensityKgPerM3 } from "../../src/core/fire/gas/ambient";
import type { Compartment, OpenFractionTable } from "../../src/core/fire/types";
import { ceilingFloorVentFlows, ceilingFloorVolumeFlows } from "../../src/core/fire/vents/ceilingFloorVent";
import {
  buildLeakageVents,
  floorLeakageFromAreaM2,
  leakageFlows,
  leakageGeometry,
  wallLeakageFromAreaM2,
} from "../../src/core/fire/vents/leakage";
import { breakpoints, openFractionAt } from "../../src/core/fire/vents/openFraction";
import {
  endFlows,
  outsideEnd,
  type MassTransfer,
  type VentEndState,
  type VerticalVentEndState,
} from "../../src/core/fire/vents/ventTypes";
import { wallVentFlows } from "../../src/core/fire/vents/wallVent";

const P0_PA = 101325;

// ---- generators -------------------------------------------------------------------------------

// A compartment end with a clearly hotter upper layer (at least 5 K) so the layer of a flow can be read from its temperature.
const arbEnd: fc.Arbitrary<VerticalVentEndState> = fc
  .record({
    heightM: fc.double({ min: 2, max: 4, noNaN: true }),
    ifaceFrac: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
    lowerK: fc.double({ min: 270, max: 320, noNaN: true }),
    dTK: fc.double({ min: 5, max: 400, noNaN: true }),
    pressurePa: fc.double({ min: -30, max: 30, noNaN: true }),
    areaM2: fc.double({ min: 4, max: 40, noNaN: true }),
  })
  .map((r) => {
    const upperK = r.lowerK + r.dTK;
    const iface = r.heightM * r.ifaceFrac;
    return {
      isOutside: false,
      floorElevationM: 0,
      heightM: r.heightM,
      interfaceHeightM: iface,
      floorPressurePa: r.pressurePa,
      upperTempK: upperK,
      lowerTempK: r.lowerK,
      upperDensityKgPerM3: ambientDensityKgPerM3(P0_PA, upperK),
      lowerDensityKgPerM3: ambientDensityKgPerM3(P0_PA, r.lowerK),
      upperVolumeM3: r.areaM2 * (r.heightM - iface),
      lowerVolumeM3: r.areaM2 * iface,
      minVolumeM3: 1e-4 * r.areaM2 * r.heightM,
    };
  });

const arbWallGeom = fc
  .record({
    sill: fc.double({ min: 0, max: 1.5, noNaN: true }),
    h: fc.double({ min: 0.1, max: 2, noNaN: true }),
    widthM: fc.double({ min: 0.1, max: 3, noNaN: true }),
    openFraction: fc.double({ min: 0.01, max: 1, noNaN: true }),
  })
  .map((r) => ({ sillM: r.sill, soffitM: r.sill + r.h, widthM: r.widthM, openFraction: r.openFraction }));

const arbOutsideAmbient = fc.record({
  tempK: fc.double({ min: 260, max: 320, noNaN: true }),
  pressureAtReferencePa: fc.constant(P0_PA),
});

// Net flow leaving end 0 minus entering end 0, and entering end 1 minus leaving end 1, from the reported four flows per end.
function netFlows(transfers: readonly MassTransfer[]): { net0Out: number; net1In: number; total: number } {
  const [a, b] = endFlows(transfers);
  const net0Out = a.upperOutKgS + a.lowerOutKgS - a.upperInKgS - a.lowerInKgS;
  const net1In = b.upperInKgS + b.lowerInKgS - b.upperOutKgS - b.lowerOutKgS;
  const total = a.upperOutKgS + a.lowerOutKgS + b.upperOutKgS + b.lowerOutKgS;
  return { net0Out, net1In, total };
}

const conserved = (x: number, y: number, total: number): boolean =>
  Math.abs(x - y) <= Math.max(1e-9, 1e-6 * total);

describe("Property 8: Closed vent is exactly closed", () => {
  // Feature: fire-zone, Property 8: Closed vent is exactly closed
  // **Validates: Requirements 4.5**
  const expectZero = (r: { transfers: MassTransfer[]; areaM2: number }): void => {
    expect(r.transfers).toHaveLength(0);
    expect(r.areaM2).toBe(0);
    for (const e of endFlows(r.transfers, true)) {
      expect(e).toEqual({ upperInKgS: 0, upperOutKgS: 0, lowerInKgS: 0, lowerOutKgS: 0 });
    }
  };

  it("wall vent with open fraction 0 has no flow, or an area below 1e-10 m2", () => {
    fc.assert(
      fc.property(arbEnd, arbEnd, arbWallGeom, fc.boolean(), (e1, e2, g, tiny) => {
        // Either the open fraction is 0, or the product height x width x f is below 1e-10.
        const geom = tiny ? { ...g, widthM: 1e-11, openFraction: 1 } : { ...g, openFraction: 0 };
        expectZero(wallVentFlows(geom, e1, e2));
      }),
      { numRuns: 100 },
    );
  });

  it("leakage vent below 1e-10 m2 has no flow", () => {
    fc.assert(
      fc.property(arbEnd, arbOutsideAmbient, fc.double({ min: 1e-14, max: 1e-11, noNaN: true }), (e, amb, area) => {
        const box = { widthM: 4, depthM: 5, heightM: 3 };
        const vent = leakageGeometry("L", "c", box, "wall", area);
        expectZero(leakageFlows(vent, e, outsideEnd(e, amb)));
      }),
      { numRuns: 100 },
    );
  });

  it("ceiling/floor vent with open fraction 0 has no flow", () => {
    fc.assert(
      fc.property(arbEnd, arbEnd, fc.double({ min: 0.01, max: 4, noNaN: true }), fc.constantFrom("round", "square"), (top, bot, area, shape) => {
        expectZero(ceilingFloorVentFlows({ areaM2: area, shape, openFraction: 0 }, top, bot, { interiorAmbientTempK: 293.15 }));
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 9: Vent mass is conserved and routed by interface height", () => {
  // Feature: fire-zone, Property 9: Vent mass is conserved and routed by interface height
  // **Validates: Requirements 4.1, 4.2, 4.8, 5.5**
  const flowsOnly = (t: readonly MassTransfer[]): MassTransfer[] => t.filter((x) => x.kind === "flow");

  it("wall vent between two compartments: net out of end 0 equals net into end 1, and layers follow temperature", () => {
    fc.assert(
      fc.property(arbEnd, arbEnd, arbWallGeom, (e1, e2, g) => {
        const r = wallVentFlows(g, e1, e2);
        const flows = flowsOnly(r.transfers);
        const n = netFlows(flows);
        expect(conserved(n.net0Out, n.net1In, n.total)).toBe(true);
        // Every flow slab leaves the layer that holds it: an upper-layer segment carries the upper temperature of the
        // end it leaves, a lower-layer segment the lower temperature.
        const ends = [e1, e2] as const;
        for (const t of flows) {
          const src = ends[t.fromEnd];
          expect(t.massKgS).toBeGreaterThanOrEqual(0);
          expect(t.sourceTempK).toBe(t.fromLayer === "upper" ? src.upperTempK : src.lowerTempK);
          expect(t.fromEnd).not.toBe(t.toEnd);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("wall vent: a vent entirely below both interfaces only takes from lower layers, entirely above only from upper", () => {
    fc.assert(
      fc.property(arbEnd, arbEnd, fc.boolean(), fc.double({ min: 0.1, max: 2, noNaN: true }), (e1, e2, above, w) => {
        const zMin = Math.min(e1.interfaceHeightM, e2.interfaceHeightM);
        const zMax = Math.max(e1.interfaceHeightM, e2.interfaceHeightM);
        const top = Math.min(e1.heightM, e2.heightM);
        const sill = above ? zMax + 1e-3 : 0;
        const soffit = above ? top : zMin - 1e-3;
        fc.pre(soffit - sill > 0.01);
        const r = wallVentFlows({ sillM: sill, soffitM: soffit, widthM: w, openFraction: 1 }, e1, e2, { spillPlume: false });
        for (const t of r.transfers) expect(t.fromLayer).toBe(above ? "upper" : "lower");
      }),
      { numRuns: 100 },
    );
  });

  it("leakage vent to the Outside conserves mass", () => {
    fc.assert(
      fc.property(
        arbEnd,
        arbOutsideAmbient,
        fc.constantFrom("wall", "floor"),
        fc.double({ min: 1e-4, max: 0.5, noNaN: true }),
        (e, amb, orientation, area) => {
          const box = { widthM: 4, depthM: 5, heightM: e.heightM };
          const vent = leakageGeometry("L", "c", box, orientation, area);
          const r = leakageFlows(vent, e, outsideEnd(e, amb));
          const n = netFlows(flowsOnly(r.transfers));
          expect(conserved(n.net0Out, n.net1In, n.total)).toBe(true);
          expect(r.transfers.every((t) => t.kind === "flow")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("ceiling/floor vent: each leg takes out what it puts in, and the legs add up to the vent flow", () => {
    fc.assert(
      fc.property(
        arbEnd,
        arbEnd,
        fc.double({ min: 0.05, max: 4, noNaN: true }),
        fc.constantFrom("round", "square"),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (top, bot, area, shape, f) => {
          const r = ceilingFloorVentFlows({ areaM2: area, shape, openFraction: f }, top, bot, { interiorAmbientTempK: 293.15 });
          const n = netFlows(r.transfers);
          expect(conserved(n.net0Out, n.net1In, n.total)).toBe(true);
          const flows = ceilingFloorVolumeFlows(f * area, shape, top, bot);
          const fromBottom = r.transfers.filter((t) => t.fromEnd === 1).reduce((s, t) => s + t.massKgS, 0);
          const fromTop = r.transfers.filter((t) => t.fromEnd === 0).reduce((s, t) => s + t.massKgS, 0);
          expect(Math.abs(fromBottom - flows.upMassKgPerS)).toBeLessThanOrEqual(1e-9 + 1e-9 * flows.upMassKgPerS);
          expect(Math.abs(fromTop - flows.downMassKgPerS)).toBeLessThanOrEqual(1e-9 + 1e-9 * flows.downMassKgPerS);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 10: Open fraction interpolation", () => {
  // Feature: fire-zone, Property 10: Open fraction interpolation
  // **Validates: Requirements 4.3, 5.3**
  // The part about accepted steps is tested in task 10.4.
  const arbTable: fc.Arbitrary<OpenFractionTable> = fc
    .array(
      fc.record({
        dt: fc.double({ min: 0.01, max: 100, noNaN: true }),
        f: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { minLength: 2, maxLength: 1000 },
    )
    .map((rows) => {
      let t = 0;
      const timesS = rows.map((r) => (t += r.dt));
      return { timesS, fractions: rows.map((r) => r.f) };
    });
  const TOL = 1e-12;

  it("is between the neighbouring values, equals the value at table times, and is held outside the table", () => {
    fc.assert(
      fc.property(
        arbTable,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.nat(),
        fc.double({ min: 0, max: 1e4, noNaN: true }),
        (table, u, idx, extra) => {
          const n = table.timesS.length;
          const times = table.timesS;
          const fr = table.fractions;
          // At every table time.
          for (let i = 0; i < n; i++) expect(openFractionAt(table, times[i]!)).toBe(fr[i]);
          // Inside one interval.
          const i = idx % (n - 1);
          const t = times[i]! + u * (times[i + 1]! - times[i]!);
          const v = openFractionAt(table, t);
          expect(v).toBeGreaterThanOrEqual(Math.min(fr[i]!, fr[i + 1]!) - TOL);
          expect(v).toBeLessThanOrEqual(Math.max(fr[i]!, fr[i + 1]!) + TOL);
          // Held before the first and after the last time.
          expect(openFractionAt(table, times[0]! - extra)).toBe(fr[0]);
          expect(openFractionAt(table, times[n - 1]! + extra)).toBe(fr[n - 1]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("uses the table times as breakpoints, and a constant has none", () => {
    fc.assert(
      fc.property(arbTable, fc.double({ min: 0, max: 1, noNaN: true }), (table, c) => {
        expect(breakpoints(table)).toEqual(table.timesS);
        expect(breakpoints(c)).toEqual([]);
        expect(openFractionAt(c, 123)).toBe(c);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 11: Ceiling vent flow follows the pressure difference", () => {
  // Feature: fire-zone, Property 11: Ceiling vent flow follows the pressure difference
  // **Validates: Requirements 5.1**
  // Equal densities in all layers: no buoyant exchange flow, so the flooding region does not apply.
  const arbUniform: fc.Arbitrary<VerticalVentEndState> = arbEnd.map((e) => ({
    ...e,
    upperTempK: e.lowerTempK,
    upperDensityKgPerM3: e.lowerDensityKgPerM3,
  }));
  const arbCase = fc
    .record({
      top: arbUniform,
      bottom: arbUniform,
      area: fc.double({ min: 0.05, max: 4, noNaN: true }),
      shape: fc.constantFrom("round" as const, "square" as const),
      // Offset of the pressure difference from zero, Pa; the sign picks the direction.
      mag: fc.double({ min: 0.01, max: 100, noNaN: true }),
    })
    // The same density everywhere, so the density difference across the vent is exactly 0.
    .map((c) => ({
      ...c,
      bottom: {
        ...c.bottom,
        upperTempK: c.top.lowerTempK,
        lowerTempK: c.top.lowerTempK,
        upperDensityKgPerM3: c.top.lowerDensityKgPerM3,
        lowerDensityKgPerM3: c.top.lowerDensityKgPerM3,
      },
    }));
  const withDelp = (c: { top: VerticalVentEndState; bottom: VerticalVentEndState }, delp: number): VerticalVentEndState => {
    // delp = (relpBelow + dpBelow) - relpAbove, with relpAbove = 0 for the reference call.
    const base = ceilingFloorVolumeFlows(1, "round", { ...c.top, floorPressurePa: 0 }, c.bottom).delpPa;
    return { ...c.top, floorPressurePa: base - delp };
  };

  it("net flow is upward for positive pressure difference, downward for negative, zero for zero", () => {
    fc.assert(
      fc.property(arbCase, fc.constantFrom(1, -1, 0), (c, sign) => {
        const top = withDelp(c, sign * c.mag);
        const f = ceilingFloorVentFlows({ areaM2: c.area, shape: c.shape, openFraction: 1 }, top, c.bottom, { interiorAmbientTempK: 293.15 });
        const up = f.transfers.filter((t) => t.fromEnd === 1).reduce((s, t) => s + t.massKgS, 0);
        const down = f.transfers.filter((t) => t.fromEnd === 0).reduce((s, t) => s + t.massKgS, 0);
        if (sign > 0) {
          expect(up).toBeGreaterThan(0);
          expect(down).toBe(0);
        } else if (sign < 0) {
          expect(down).toBeGreaterThan(0);
          expect(up).toBe(0);
        } else {
          expect(up).toBe(0);
          expect(down).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("a larger pressure difference gives a larger flow", () => {
    fc.assert(
      fc.property(arbCase, fc.double({ min: 1.1, max: 10, noNaN: true }), (c, k) => {
        const flow = (d: number): number =>
          ceilingFloorVolumeFlows(c.area, c.shape, withDelp(c, d), c.bottom).upMassKgPerS;
        expect(flow(c.mag * k)).toBeGreaterThan(flow(c.mag));
      }),
      { numRuns: 100 },
    );
  });
});

describe("Leakage vent geometry against hand values", () => {
  // Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage).
  const box = { widthM: 4, depthM: 5, heightM: 3 };

  it("wall leakage: sill 5 %, soffit 95 % of 3 m, width = area / 2.7 m", () => {
    // Wall ratio 1e-4 of 2 (4 + 5) 3 = 54 m2 gives 0.0054 m2.
    const g = wallLeakageFromAreaM2(box, 1e-4 * 54);
    expect(g.sillM).toBeCloseTo(0.15, 12);
    expect(g.soffitM).toBeCloseTo(2.85, 12);
    expect(g.widthM).toBeCloseTo(0.0054 / 2.7, 12); // 0.002 m
  });

  it("floor leakage: width 0.9 (4 + 5) / 2 = 4.05 m, sill 0, soffit = area / 4.05", () => {
    // Floor ratio 2e-4 of 4 x 5 = 20 m2 gives 0.004 m2.
    const g = floorLeakageFromAreaM2(box, 2e-4 * 20);
    expect(g.sillM).toBe(0);
    expect(g.widthM).toBeCloseTo(4.05, 12);
    expect(g.soffitM).toBeCloseTo(0.004 / 4.05, 12); // 9.8765e-4 m
  });

  it("buildLeakageVents gives wall then floor leakage, fully open, with the requested area", () => {
    const c = { id: "A", ...box, leakage: { wallAreaRatio: 1e-4, floorAreaRatio: 2e-4 } } as unknown as Compartment;
    const none = { id: "B", ...box } as unknown as Compartment;
    const vents = buildLeakageVents([c, none]);
    expect(vents.map((v) => v.id)).toEqual(["Wall Leak A", "Floor Leak A"]);
    expect(vents.map((v) => v.orientation)).toEqual(["wall", "floor"]);
    for (const v of vents) {
      expect(v.openFraction).toBe(1);
      expect(v.compartmentId).toBe("A");
    }
    expect((vents[0]!.soffitM - vents[0]!.sillM) * vents[0]!.widthM).toBeCloseTo(0.0054, 12);
    expect((vents[1]!.soffitM - vents[1]!.sillM) * vents[1]!.widthM).toBeCloseTo(0.004, 12);
  });
});
