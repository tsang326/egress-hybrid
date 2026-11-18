// Property and unit tests for the heat transfer modules (tasks.md 6.3).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONDUCTION_NODE_COUNT, SIGMA_SB_W_PER_M2_K4 } from "../../src/core/fire/constants";
import { configurationFactors } from "../../src/core/fire/heat/configFactors";
import { placeNodes, stepConduction, type WallGrid } from "../../src/core/fire/heat/conduction";
import { bilinearClamped } from "../../src/core/fire/heat/gasAbsorption";
import {
  CO2_LOG10_EMISSIVITY,
  CO2_LOG10_T_K,
  H2O_LOG10_EMISSIVITY,
  H2O_LOG10_T_K,
  LOG10_PL_ATM_M,
} from "../../src/core/fire/heat/gasAbsorptionData";
import { surfaceRadiation, type RadiationFire, type RadiationInput } from "../../src/core/fire/heat/radiation";
import type { SurfaceLayer } from "../../src/core/fire/types";

const RUNS = { numRuns: 100 };

// ---------------------------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------------------------

const arbRadiationCase = fc
  .record({
    widthM: fc.double({ min: 2, max: 12, noNaN: true }),
    depthM: fc.double({ min: 2, max: 12, noNaN: true }),
    heightM: fc.double({ min: 2, max: 5, noNaN: true }),
    interfaceFraction: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
    upperTempK: fc.double({ min: 290, max: 1200, noNaN: true }),
    lowerTempK: fc.double({ min: 280, max: 600, noNaN: true }),
    surfaceTempK: fc.array(fc.double({ min: 280, max: 900, noNaN: true }), { minLength: 4, maxLength: 4 }),
    emissivity: fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }),
    upperAbsorptionPerM: fc.double({ min: 0.01, max: 2, noNaN: true }),
    lowerAbsorptionPerM: fc.double({ min: 0.01, max: 2, noNaN: true }),
    fires: fc.array(
      fc.record({
        fx: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fy: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        radiativeW: fc.double({ min: 0, max: 2e5, noNaN: true }),
        flameHeightM: fc.double({ min: 0, max: 4, noNaN: true }),
        baseZM: fc.double({ min: 0, max: 0.5, noNaN: true }),
      }),
      { maxLength: 2 },
    ),
  })
  .map((r): RadiationInput => {
    const fires: RadiationFire[] = r.fires.map((f) => ({
      xM: f.fx * r.widthM,
      yM: f.fy * r.depthM,
      baseZM: f.baseZM,
      flameHeightM: f.flameHeightM,
      radiativeW: f.radiativeW,
    }));
    return {
      widthM: r.widthM,
      depthM: r.depthM,
      heightM: r.heightM,
      interfaceHeightM: r.interfaceFraction * r.heightM,
      upperTempK: r.upperTempK,
      lowerTempK: r.lowerTempK,
      surfaceTempK: r.surfaceTempK,
      emissivity: r.emissivity,
      upperAbsorptionPerM: r.upperAbsorptionPerM,
      lowerAbsorptionPerM: r.lowerAbsorptionPerM,
      fires,
    };
  });

describe("heat transfer properties", () => {
  // Feature: fire-zone, Property 18: Surface energy balance
  // The heat that leaves the gas side (fire radiation plus net gas emission, i.e. minus what the layers absorb)
  // equals the heat that enters the four surfaces. Convection is balanced by construction in residual.ts
  // (the same flux times the same area is added to the surface residual and subtracted from the layer).
  it("Property 18: Surface energy balance", () => {
    // **Validates: Requirements 7.4**
    fc.assert(
      fc.property(arbRadiationCase, (input) => {
        const r = surfaceRadiation(input);
        const { areasM2 } = configurationFactors(input.widthM, input.depthM, input.heightM, input.interfaceHeightM);
        const fireW = input.fires.reduce((s, f) => s + f.radiativeW, 0);
        const leavesGasW = fireW - r.absorbedUpperW - r.absorbedLowerW;
        const entersSurfacesW = r.fluxToSurfaceWPerM2.reduce((s, q, k) => s + q * (areasM2[k] as number), 0);
        const diff = Math.abs(leavesGasW - entersSurfacesW);
        const scale = Math.max(Math.abs(leavesGasW), Math.abs(entersSurfacesW));
        if (scale < 1e-3) return diff <= 1e-9;
        return diff <= 1e-6 * scale;
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Radiation unit tests
// ---------------------------------------------------------------------------------------------

describe("radiation", () => {
  it("an enclosure with every surface and both gas layers at one temperature has zero net flux", () => {
    const tK = 400;
    const r = surfaceRadiation({
      widthM: 5,
      depthM: 4,
      heightM: 2.5,
      interfaceHeightM: 1.2,
      upperTempK: tK,
      lowerTempK: tK,
      surfaceTempK: [tK, tK, tK, tK],
      emissivity: [0.9, 0.8, 0.7, 0.6],
      upperAbsorptionPerM: 0.5,
      lowerAbsorptionPerM: 0.1,
      fires: [],
    });
    const blackbody = SIGMA_SB_W_PER_M2_K4 * tK ** 4;
    for (const q of r.fluxToSurfaceWPerM2) expect(Math.abs(q)).toBeLessThan(1e-9 * blackbody);
    expect(Math.abs(r.absorbedUpperW)).toBeLessThan(1e-9 * blackbody);
    expect(Math.abs(r.absorbedLowerW)).toBeLessThan(1e-9 * blackbody);
  });

  it("configuration factors: rows sum to 1 (Eq. 5.15) and A_i F_ij = A_j F_ji (Eq. 5.16)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 15, noNaN: true }),
        fc.double({ min: 1, max: 15, noNaN: true }),
        fc.double({ min: 1, max: 6, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        (w, d, h, frac) => {
          const { areasM2, factors } = configurationFactors(w, d, h, frac * h);
          for (let k = 0; k < 4; k++) {
            let sum = 0;
            for (let j = 0; j < 4; j++) {
              const f = factors[4 * k + j] as number;
              expect(f).toBeGreaterThanOrEqual(-1e-12);
              sum += f;
              const recip = (areasM2[j] as number) * (factors[4 * j + k] as number);
              const lhs = (areasM2[k] as number) * f;
              expect(Math.abs(lhs - recip)).toBeLessThanOrEqual(1e-9 * Math.max(lhs, recip, 1e-12));
            }
            expect(sum).toBeCloseTo(1, 12);
          }
        },
      ),
      RUNS,
    );
  });

  it("a flat surface sees no part of itself (F11 = 0, F44 = 0)", () => {
    const { factors } = configurationFactors(4, 3, 2.5, 1);
    expect(factors[0]).toBe(0);
    expect(factors[15]).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Emissivity tables against CFAST 7.7.7 source, radiation.f90 (absorb), values read from that file
// ---------------------------------------------------------------------------------------------

describe("emissivity tables", () => {
  const last = (a: readonly number[]): number => a.length - 1;
  // [temperature index, pL index, log10 emissivity in radiation.f90]
  const co2Spots: [number, number, number][] = [
    [0, 0, -1.8508], // first value of eco2
    [10, 0, -2.8996], // last value of the first row
    [0, 11, -0.8013],
    [10, 11, -0.9431], // last value of eco2
    [5, 5, -1.04], // centre
  ];
  const h2oSpots: [number, number, number][] = [
    [0, 0, -1.15],
    [10, 0, -3.4437],
    [0, 11, -0.262],
    [10, 11, -0.5086],
    [5, 5, -1.02],
  ];

  it("table shapes are 11 temperatures by 12 path lengths", () => {
    expect(CO2_LOG10_T_K).toHaveLength(11);
    expect(H2O_LOG10_T_K).toHaveLength(11);
    expect(LOG10_PL_ATM_M).toHaveLength(12);
    expect(CO2_LOG10_EMISSIVITY).toHaveLength(12);
    expect(H2O_LOG10_EMISSIVITY).toHaveLength(12);
    for (const row of [...CO2_LOG10_EMISSIVITY, ...H2O_LOG10_EMISSIVITY]) expect(row).toHaveLength(11);
    expect(last(CO2_LOG10_T_K)).toBe(10);
  });

  it("CO2 corners and centre match the CFAST source and the interpolator returns them at grid points", () => {
    for (const [i, j, v] of co2Spots) {
      expect((CO2_LOG10_EMISSIVITY[j] as readonly number[])[i]).toBe(v);
      expect(
        bilinearClamped(CO2_LOG10_T_K, LOG10_PL_ATM_M, CO2_LOG10_EMISSIVITY, CO2_LOG10_T_K[i] as number, LOG10_PL_ATM_M[j] as number),
      ).toBeCloseTo(v, 12);
    }
  });

  it("H2O corners and centre match the CFAST source and the interpolator returns them at grid points", () => {
    for (const [i, j, v] of h2oSpots) {
      expect((H2O_LOG10_EMISSIVITY[j] as readonly number[])[i]).toBe(v);
      expect(
        bilinearClamped(H2O_LOG10_T_K, LOG10_PL_ATM_M, H2O_LOG10_EMISSIVITY, H2O_LOG10_T_K[i] as number, LOG10_PL_ATM_M[j] as number),
      ).toBeCloseTo(v, 12);
    }
  });

  it("the interpolator clamps outside the table", () => {
    expect(bilinearClamped(CO2_LOG10_T_K, LOG10_PL_ATM_M, CO2_LOG10_EMISSIVITY, 0, -10)).toBeCloseTo(-1.8508, 12);
    expect(bilinearClamped(CO2_LOG10_T_K, LOG10_PL_ATM_M, CO2_LOG10_EMISSIVITY, 9, 9)).toBeCloseTo(-0.9431, 12);
  });
});

// ---------------------------------------------------------------------------------------------
// Conduction
// ---------------------------------------------------------------------------------------------

const concrete: SurfaceLayer = {
  name: "concrete (test value)",
  conductivityWPerMK: 1.6,
  densityKgPerM3: 2400,
  specificHeatJPerKgK: 750,
  thicknessM: 0.2,
  emissivity: 0.9,
};

// Abramowitz and Stegun 7.1.26 style erfc is too coarse (1.5e-7 is fine here, the bound below is 1e-2 K scale).
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return s * (1 - poly * Math.exp(-a * a));
}

describe("conduction grid", () => {
  const arbLayer = fc.record({
    name: fc.constant("layer"),
    conductivityWPerMK: fc.double({ min: 0.03, max: 50, noNaN: true }),
    densityKgPerM3: fc.double({ min: 50, max: 8000, noNaN: true }),
    specificHeatJPerKgK: fc.double({ min: 400, max: 2000, noNaN: true }),
    thicknessM: fc.double({ min: 0.005, max: 0.3, noNaN: true }),
    emissivity: fc.constant(0.9),
  });

  it("has 30 nodes, increasing positions from 0 to the wall thickness", () => {
    fc.assert(
      fc.property(fc.array(arbLayer, { minLength: 1, maxLength: 3 }), (layers) => {
        const g = placeNodes(layers);
        expect(g.nodeCount).toBe(30);
        expect(CONDUCTION_NODE_COUNT).toBe(30);
        expect(g.xM).toHaveLength(30);
        expect(g.xM[0]).toBe(0);
        expect(g.xM[29]).toBeCloseTo(layers.reduce((s, l) => s + l.thicknessM, 0), 12);
        for (let i = 1; i < 30; i++) expect(g.xM[i] as number).toBeGreaterThan(g.xM[i - 1] as number);
      }),
      RUNS,
    );
  });

  it("single layer: the smallest spacing is at the exposed face", () => {
    fc.assert(
      fc.property(arbLayer, (layer) => {
        const g = placeNodes([layer]);
        expect(g.dxM[0]).toBe(Math.min(...g.dxM));
      }),
      RUNS,
    );
  });

  it("multi layer: spacing grows from the exposed face through the first layer", () => {
    fc.assert(
      fc.property(fc.array(arbLayer, { minLength: 2, maxLength: 3 }), (layers) => {
        const g = placeNodes(layers);
        const nFirst = (g.interiorNodesPerLayer[0] as number) + 1;
        for (let i = 1; i < nFirst; i++) expect(g.dxM[i] as number).toBeGreaterThanOrEqual(g.dxM[i - 1] as number);
        expect(g.dxM[0]).toBeLessThan(g.dxM[nFirst - 1] as number + 1e-300);
      }),
      RUNS,
    );
  });

  it("rejects zero and four layers as programmer errors", () => {
    expect(() => placeNodes([])).toThrow(TypeError);
    expect(() => placeNodes([concrete, concrete, concrete, concrete])).toThrow(TypeError);
  });
});

describe("conduction against the semi-infinite solid", () => {
  // Surface held at Ts from t = 0 over a wall at Ti. T(x, t) = Ti + (Ts - Ti) erfc(x / (2 sqrt(alpha t))).
  // Wall is 0.2 m; penetration 2 sqrt(alpha t) = 0.05 m at 600 s, so the back face stays at Ti (insulated, zero flux).
  // Stated bound: max error of the node temperatures <= 2 % of the step (Ts - Ti), for 1 s backward Euler steps.
  const BOUND_FRACTION = 0.02;

  it("matches erfc profile and surface gradient within the stated bound", () => {
    const grid: WallGrid = placeNodes([concrete]);
    const ti = 300;
    const ts = 400;
    const current = new Float64Array(30).fill(ti);
    const trial = new Float64Array(30);
    const dt = 1;
    const steps = 600;
    let gradient = 0;
    for (let n = 0; n < steps; n++) {
      gradient = stepConduction(grid, current, trial, ts, dt, 0).gradientKPerM;
      current.set(trial);
    }
    const alpha = concrete.conductivityWPerMK / (concrete.densityKgPerM3 * concrete.specificHeatJPerKgK);
    const tEnd = steps * dt;
    let maxErr = 0;
    for (let i = 0; i < 30; i++) {
      const x = grid.xM[i] as number;
      const exact = ti + (ts - ti) * (1 - erf(x / (2 * Math.sqrt(alpha * tEnd))));
      maxErr = Math.max(maxErr, Math.abs((current[i] as number) - exact));
    }
    expect(maxErr).toBeLessThanOrEqual(BOUND_FRACTION * (ts - ti));
    // Exact surface gradient dT/dx = -(Ts - Ti) / sqrt(pi alpha t) is negative (cooler inside). The reported value
    // is a first-order difference over the first interval, so it is bounded within 5 % here.
    const exactGradient = -(ts - ti) / Math.sqrt(Math.PI * alpha * tEnd);
    expect(Math.abs(gradient - exactGradient)).toBeLessThanOrEqual(0.05 * Math.abs(exactGradient));
    // The derivative of the gradient with respect to the surface temperature is finite and has the sign of -1/dx.
    expect(grid.result.dGradientDTw).toBeLessThan(0);
  });
});

describe("conduction with layered materials", () => {
  const insulation: SurfaceLayer = {
    name: "insulation (test value)",
    conductivityWPerMK: 0.04,
    densityKgPerM3: 100,
    specificHeatJPerKgK: 1000,
    thicknessM: 0.05,
    emissivity: 0.9,
  };
  const steel: SurfaceLayer = {
    name: "steel (test value)",
    conductivityWPerMK: 45,
    densityKgPerM3: 7850,
    specificHeatJPerKgK: 460,
    thicknessM: 0.01,
    emissivity: 0.8,
  };

  it("grid stores each layer's conductivity and diffusivity", () => {
    const g = placeNodes([insulation, concrete, steel]);
    expect(g.conductivityWPerMK).toEqual([0.04, 1.6, 45]);
    expect(g.diffusivityM2PerS[0]).toBeCloseTo(0.04 / (100 * 1000), 15);
    expect(g.diffusivityM2PerS[1]).toBeCloseTo(1.6 / (2400 * 750), 15);
    expect(g.diffusivityM2PerS[2]).toBeCloseTo(45 / (7850 * 460), 15);
    expect(g.thicknessM).toBeCloseTo(0.26, 12);
    expect(g.interiorNodesPerLayer.reduce((s, n) => s + n, 0)).toBe(30 - 4);
  });

  it("steady state uses each layer's conductivity: gradient in layer i is q / k_i", () => {
    const g = placeNodes([insulation, steel]);
    const n = g.nodeCount;
    const current = new Float64Array(n).fill(300);
    const trial = new Float64Array(n);
    const q = 50; // W/m2 imposed through the back-face flux condition (T[n-1] - T[n-2] = dx q / k_last)
    // Backward Euler converges as 1/(1 + dt/tau), so take a few huge steps to reach the steady profile.
    for (let s = 0; s < 8; s++) {
      stepConduction(g, current, trial, 350, 1e6, q);
      current.set(trial);
    }
    const iface = (g.interiorNodesPerLayer[0] as number) + 1;
    const slope = (i: number): number => ((trial[i] as number) - (trial[i - 1] as number)) / (g.dxM[i - 1] as number);
    for (let i = 1; i <= iface; i++) expect(Math.abs(slope(i) / (q / 0.04) - 1)).toBeLessThan(1e-4);
    for (let i = iface + 1; i < n; i++) expect(Math.abs(slope(i) / (q / 45) - 1)).toBeLessThan(1e-4);
  });

  it("early-time response follows the first layer, not the second", () => {
    const g = placeNodes([concrete, steel]);
    const current = new Float64Array(30).fill(300);
    const trial = new Float64Array(30);
    let gradient = 0;
    for (let n = 0; n < 60; n++) {
      gradient = stepConduction(g, current, trial, 400, 1, 0).gradientKPerM;
      current.set(trial);
    }
    const alpha = 1.6 / (2400 * 750);
    const exact = -100 / Math.sqrt(Math.PI * alpha * 60);
    expect(Math.abs(gradient - exact)).toBeLessThanOrEqual(0.05 * Math.abs(exact));
  });
});
