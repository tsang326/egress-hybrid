// Property and unit tests for the gas state modules (tasks.md 3.2).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CP_J_PER_KG_K, GAMMA, GAS_R_J_PER_KG_K, GRAVITY_M_PER_S2 } from "../../src/core/fire/constants";
import { ambientDensityKgPerM3, ambientPressureAtPa } from "../../src/core/fire/gas/ambient";
import { interfaceHeightM, layerDerivatives, layerMassKg } from "../../src/core/fire/gas/layerEquations";
import { layerMixing } from "../../src/core/fire/gas/layerMixing";
import {
  clampUpperVolumeM3,
  copyShaftSpeciesFractions,
  initialUpperVolumeM3,
  maxLayerVolumeM3,
  mergeShaftFlows,
  minLayerVolumeM3,
  shaftLowerTempK,
  shaftUpperVolumeRate,
} from "../../src/core/fire/gas/minVolume";

const NUM_RUNS = 100;

describe("gas modules: properties", () => {
  // Feature: fire-zone, Property 4: Hydrostatic pressure difference
  // **Validates: Requirements 2.5**
  it("Property 4: ambient pressure difference between two floors is rho0 g dz", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 1, max: 60, noNaN: true }),
        fc.double({ min: 95_000, max: 105_000, noNaN: true }),
        fc.double({ min: 253, max: 313, noNaN: true }),
        (z1, dz, p0, tExt) => {
          const z2 = z1 + dz;
          const rho0 = ambientDensityKgPerM3(p0, tExt);
          const diff = ambientPressureAtPa(z1, p0, tExt) - ambientPressureAtPa(z2, p0, tExt);
          const expected = rho0 * GRAVITY_M_PER_S2 * dz;
          expect(Math.abs(diff - expected)).toBeLessThanOrEqual(0.01 * expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: fire-zone, Property 5: Interface height stays in range
  // **Validates: Requirements 3.4, 3.6**
  it("Property 5: clamped upper volume is in [VMIN, V - VMIN] and interface height in [0, H]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 20, noNaN: true }),
        fc.double({ min: 1, max: 20, noNaN: true }),
        fc.double({ min: 1, max: 6, noNaN: true }),
        fc.double({ min: -1e4, max: 1e5, noNaN: true }),
        (w, d, h, vuRaw) => {
          const v = w * d * h;
          const vmin = Math.min(1e-4 * v, 1);
          const vu = clampUpperVolumeM3(vuRaw, v);
          expect(vu).toBeGreaterThanOrEqual(vmin);
          expect(vu).toBeLessThanOrEqual(v - vmin);
          const z = interfaceHeightM(h, vu, w * d);
          expect(z).toBeGreaterThanOrEqual(0);
          expect(z).toBeLessThanOrEqual(h);
          // Within the clamp range the interface height is H - Vu / (W D) (the clamp to [0, H] only guards rounding).
          expect(Math.abs(z - (h - vu / (w * d)))).toBeLessThanOrEqual(1e-9 * h);
          // Even an unclamped input gives a height in range.
          const zRaw = interfaceHeightM(h, vuRaw, w * d);
          expect(zRaw).toBeGreaterThanOrEqual(0);
          expect(zRaw).toBeLessThanOrEqual(h);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: fire-zone, Property 7: Gas equations are consistent with the ideal gas law
  // **Validates: Requirements 3.1, 3.3**
  it("Property 7: Eq. 2.5 to 2.8 reproduce the layer mass and enthalpy rates of m = P V / (R T)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 1000, noNaN: true }), // V
        fc.double({ min: 0.05, max: 0.95, noNaN: true }), // Vu / V
        fc.double({ min: 90_000, max: 110_000, noNaN: true }), // P
        fc.double({ min: 250, max: 1200, noNaN: true }), // Tu
        fc.double({ min: 250, max: 600, noNaN: true }), // Tl
        fc.double({ min: -1e6, max: 1e6, noNaN: true }), // qu
        fc.double({ min: -1e6, max: 1e6, noNaN: true }), // ql
        fc.double({ min: -5, max: 5, noNaN: true }), // mdot upper
        fc.double({ min: -5, max: 5, noNaN: true }), // mdot lower
        (v, frac, p, tu, tl, qu, ql, mdu, mdl) => {
          const vu = frac * v;
          const vl = v - vu;
          const out = new Float64Array(4);
          layerDerivatives(
            v,
            vl,
            { pressurePa: p, upperVolumeM3: vu, upperTempK: tu, lowerTempK: tl },
            { qUpperW: qu, qLowerW: ql, mdotUpperKgPerS: mdu, mdotLowerKgPerS: mdl },
            out,
          );
          const [dP, dVu, dTu, dTl] = out as unknown as [number, number, number, number];
          const R = GAS_R_J_PER_KG_K;
          const mu = layerMassKg(p, vu, tu);
          const ml = layerMassKg(p, vl, tl);
          // d(m)/dt of m = P V / (R T) by the product and quotient rules, with dVl = -dVu.
          const dmu = (dP * vu + p * dVu) / (R * tu) - (p * vu * dTu) / (R * tu * tu);
          const dml = (dP * vl - p * dVu) / (R * tl) - (p * vl * dTl) / (R * tl * tl);
          const tolMass = 1e-9 * Math.max(1, Math.abs(mdu), Math.abs(mdl), Math.abs(dmu), Math.abs(dml));
          expect(Math.abs(dmu - mdu)).toBeLessThanOrEqual(tolMass);
          expect(Math.abs(dml - mdl)).toBeLessThanOrEqual(tolMass);
          // Layer enthalpy balance: cp d(m T)/dt = q + V_layer dP/dt.
          const dHu = CP_J_PER_KG_K * (dmu * tu + mu * dTu);
          const dHl = CP_J_PER_KG_K * (dml * tl + ml * dTl);
          const tolE = 1e-9 * Math.max(1, Math.abs(qu), Math.abs(ql), Math.abs(dHu), Math.abs(dHl));
          expect(Math.abs(dHu - (qu + vu * dP))).toBeLessThanOrEqual(tolE);
          expect(Math.abs(dHl - (ql + vl * dP))).toBeLessThanOrEqual(tolE);
          // Total: V dP/dt = (gamma - 1)(ql + qu), the pressure rise implied by P V = sum m R T.
          expect(Math.abs(v * dP - (GAMMA - 1) * (ql + qu))).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ql + qu)));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("gas modules: unit tests", () => {
  const species = [0.2, 0.3, 0.5];
  const base = {
    ceilingAreaM2: 20,
    lowerMassKg: 50,
    lowerDensityKgPerM3: 1.2,
    minLayerVolumeM3: 0.01,
    lowerSpeciesMassKg: species,
  };

  it("layer mixing is zero when Tl <= Tu", () => {
    for (const [tu, tl] of [
      [400, 300],
      [300, 300],
    ] as const) {
      const r = layerMixing({ ...base, upperTempK: tu, lowerTempK: tl });
      expect(r.energyUpperW).toBe(0);
      expect(r.massUpperKgPerS).toBe(0);
      expect(Array.from(r.speciesUpperKgPerS)).toEqual([0, 0, 0]);
    }
  });

  it("layer mixing moves 1000 (Tl - Tu)^2 A upward when Tl > Tu, with species in lower-layer proportion", () => {
    const r = layerMixing({ ...base, upperTempK: 300, lowerTempK: 310 });
    expect(r.energyUpperW).toBeCloseTo(1000 * 100 * 20, 6);
    // Lower mass is far above 2 vmin rho, so the mass factor is its maximum, 0.5.
    expect(r.massUpperKgPerS).toBeCloseTo((0.5 * r.energyUpperW) / (CP_J_PER_KG_K * 310), 9);
    r.speciesUpperKgPerS.forEach((s, i) => expect(s).toBeCloseTo(species[i]! * r.massUpperKgPerS, 12));
  });

  it("a shaft keeps Vu constant and Tl = Tu", () => {
    expect(shaftUpperVolumeRate(true, 0.37)).toBe(0);
    expect(shaftUpperVolumeRate(false, 0.37)).toBe(0.37);
    expect(shaftLowerTempK(345.5)).toBe(345.5);
    expect(initialUpperVolumeM3(100, true)).toBe(maxLayerVolumeM3(100));
    expect(initialUpperVolumeM3(100, false)).toBe(minLayerVolumeM3(100));

    const merged = mergeShaftFlows({ qUpperW: 100, qLowerW: 40, mdotUpperKgPerS: 0.5, mdotLowerKgPerS: -0.2 });
    expect(merged).toEqual({ qUpperW: 140, qLowerW: 0, mdotUpperKgPerS: 0.3, mdotLowerKgPerS: 0 });

    const lower = new Float64Array(3);
    copyShaftSpeciesFractions([0.1, 0.2, 0.7], lower);
    expect(Array.from(lower)).toEqual([0.1, 0.2, 0.7]);
  });
});
