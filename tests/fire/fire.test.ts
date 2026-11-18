// Tests for src/core/fire/fire (task 4.2): HRR table, burn limit, plume entrainment, chemistry balance.
// Requirements 6.3, 6.4, 6.7 to 6.11, 6.13.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  burn,
  evaluateFire,
  fireDrive,
  interpolateRow,
  oxygenFactor,
} from '../../src/core/fire/fire/heatRelease';
import {
  entrainmentEq317,
  heskestadEntrainment,
  mirrorFactor,
  plumeGeometry,
  upperPlumeArgs,
} from '../../src/core/fire/fire/plume';
import {
  fuelMolarMassKgPerMol,
  speciesRates,
  stoichiometry,
} from '../../src/core/fire/fire/chemistry';
import {
  ATOMIC_MASS_C_KG_PER_MOL,
  ATOMIC_MASS_H_KG_PER_MOL,
  ATOMIC_MASS_O_KG_PER_MOL,
  MOLAR_MASS_CO2_KG_PER_MOL,
  MOLAR_MASS_CO_KG_PER_MOL,
  MOLAR_MASS_H2O_KG_PER_MOL,
} from '../../src/core/fire/constants';
import type { Fire, HrrRow } from '../../src/core/fire/types';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const arbRow = (timeS: number): fc.Arbitrary<HrrRow> =>
  fc.record({
    timeS: fc.constant(timeS),
    hrrW: fc.double({ min: 0, max: 1e6, noNaN: true }),
    heightM: fc.double({ min: 0, max: 2, noNaN: true }),
    areaM2: fc.double({ min: 0.05, max: 4, noNaN: true }),
    coYield: fc.double({ min: 0, max: 0.2, noNaN: true }),
    sootYield: fc.double({ min: 0, max: 0.2, noNaN: true }),
  });

// Strictly increasing row times, 1 to 8 rows.
const arbTable: fc.Arbitrary<HrrRow[]> = fc
  .array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 })
  .chain((steps) => {
    let t = 0;
    const times = steps.map((s) => (t += s));
    return fc.tuple(...times.map((x) => arbRow(x)));
  })
  .map((rows) => rows as HrrRow[]);

const arbFuel = fc
  .record({
    c: fc.double({ min: 1, max: 10, noNaN: true }),
    h: fc.double({ min: 0, max: 20, noNaN: true }),
    oFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    n: fc.double({ min: 0, max: 2, noNaN: true }),
  })
  // oxygen atoms at most the carbon count keeps the O2 demand positive
  .map(({ c, h, oFrac, n }) => ({ c, h, o: oFrac * c, n, cl: 0 }));

const arbYields = fc.record({
  coYield: fc.double({ min: 0, max: 0.1, noNaN: true }),
  sootYield: fc.double({ min: 0, max: 0.1, noNaN: true }),
});

// ---------------------------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------------------------

describe('HRR table', () => {
  // Feature: fire-zone, Property 14: HRR table interpolation and hold
  // **Validates: Requirements 6.1, 6.3, 6.4**
  it('Property 14: interpolation stays between neighbours, hits rows, holds the last row', () => {
    const cols = ['hrrW', 'heightM', 'areaM2', 'coYield', 'sootYield'] as const;
    fc.assert(
      fc.property(arbTable, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 500, noNaN: true }), (table, u, extra) => {
        const first = table[0]!;
        const last = table[table.length - 1]!;
        // at row times
        for (const row of table) {
          const r = interpolateRow(table, row.timeS);
          for (const c of cols) expect(r[c]).toBeCloseTo(row[c], 9);
        }
        // between rows
        for (let i = 0; i + 1 < table.length; i++) {
          const a = table[i]!;
          const b = table[i + 1]!;
          const t = a.timeS + u * (b.timeS - a.timeS);
          const r = interpolateRow(table, t);
          for (const c of cols) {
            const lo = Math.min(a[c], b[c]);
            const hi = Math.max(a[c], b[c]);
            const eps = 1e-9 * (1 + Math.abs(hi));
            expect(r[c]).toBeGreaterThanOrEqual(lo - eps);
            expect(r[c]).toBeLessThanOrEqual(hi + eps);
          }
        }
        // hold after the last row and before the first row
        const after = interpolateRow(table, last.timeS + extra);
        for (const c of cols) expect(after[c]).toBe(last[c]);
        const before = interpolateRow(table, first.timeS - extra);
        for (const c of cols) expect(before[c]).toBe(first[c]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('interpolates linearly at the midpoint of two rows', () => {
    const table: HrrRow[] = [
      { timeS: 0, hrrW: 0, heightM: 0, areaM2: 1, coYield: 0, sootYield: 0 },
      { timeS: 10, hrrW: 1000, heightM: 1, areaM2: 3, coYield: 0.02, sootYield: 0.04 },
    ];
    const r = interpolateRow(table, 5);
    expect(r.hrrW).toBeCloseTo(500, 9);
    expect(r.areaM2).toBeCloseTo(2, 9);
    expect(r.sootYield).toBeCloseTo(0.02, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 15 and oxygen factor
// ---------------------------------------------------------------------------------------------

describe('burned HRR', () => {
  // Feature: fire-zone, Property 15: Burned HRR is bounded and limited by oxygen
  // **Validates: Requirements 6.7, 6.8, 6.9**
  it('Property 15: 0 <= burned <= table HRR, and 0 when O2 <= 0.15', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-6, max: 0.1, noNaN: true }), // pyrolysis kg/s
        fc.double({ min: 1e6, max: 1e8, noNaN: true }), // heat of combustion
        fc.double({ min: 0, max: 20, noNaN: true }), // entrainment kg/s
        fc.double({ min: 0, max: 0.23, noNaN: true }), // O2 mass fraction
        arbFuel,
        arbYields,
        (pyrolysisKgS, hocJPerKg, entrainmentKgS, sourceO2, fuel, yields) => {
          const b = burn({ pyrolysisKgS, hocJPerKg, entrainmentKgS, sourceO2, fuel, ...yields });
          const tableHrr = pyrolysisKgS * hocJPerKg;
          expect(b.hrrW).toBeGreaterThanOrEqual(0);
          expect(b.hrrW).toBeLessThanOrEqual(tableHrr * (1 + 1e-12));
          if (sourceO2 <= 0.15) {
            expect(b.hrrW).toBe(0);
            expect(b.hrrW).toBeLessThan(tableHrr);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('oxygen factor is 0 at 0.15 and 1 at 0.16', () => {
    expect(oxygenFactor(0.15)).toBe(0);
    expect(oxygenFactor(0.16)).toBe(1);
    expect(oxygenFactor(0.10)).toBe(0);
    expect(oxygenFactor(0.23)).toBe(1);
    const mid = oxygenFactor(0.155);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 16 and plume unit tests
// ---------------------------------------------------------------------------------------------

const T_AMB = 293.15;

// Independent restatement of Tech Ref 3.3.1 / 3.3.2 for a given mirror factor.
function expectedEntrainment(totalW: number, convW: number, areaM2: number, zM: number, mirror: number): number {
  const geo = plumeGeometry(0.001 * totalW * mirror, areaM2, mirror, T_AMB);
  const above = zM > geo.flameHeightM;
  const dz = Math.max(1e-4, (above ? zM : geo.flameHeightM) - geo.virtualOriginM);
  const f = above ? 1 : zM / geo.flameHeightM;
  return (entrainmentEq317(0.001 * convW * mirror, dz, T_AMB) * f) / mirror;
}

describe('plume entrainment', () => {
  const arbPlume = fc.record({
    q: fc.double({ min: 1e4, max: 2e6, noNaN: true }),
    chi: fc.double({ min: 0, max: 0.5, noNaN: true }),
    area: fc.double({ min: 0.05, max: 4, noNaN: true }),
    z: fc.double({ min: 0.1, max: 6, noNaN: true }),
  }).filter((p) => plumeGeometry(0.001 * p.q, p.area, 1, T_AMB).qStar >= 0.2); // design.md Property 16: Q* >= 0.2

  const entrain = (p: { q: number; chi: number; area: number; z: number }, x: number, y: number): number =>
    heskestadEntrainment({
      totalHrrW: p.q, convectiveHrrW: p.q * (1 - p.chi), fireAreaM2: p.area, xWallDistM: x, yWallDistM: y,
      heightM: p.z, ambientTempK: T_AMB, pyrolysisKgS: 0.01,
    }).entrainmentKgS;

  // Feature: fire-zone, Property 16: Plume entrainment ordering
  // **Validates: Requirements 6.10**
  it('Property 16: centre and single-wall are free, corner is the corner value and not larger', () => {
    fc.assert(
      fc.property(arbPlume, (p) => {
        const reach = Math.sqrt(p.area) / 2;
        const far = reach + 1; // not touching a wall
        const free = entrain(p, far, far);
        expect(free).toBeGreaterThan(0);
        expect(free).toBeCloseTo(expectedEntrainment(p.q, p.q * (1 - p.chi), p.area, p.z, 1), 9);
        // single wall in x, single wall in y
        expect(entrain(p, reach, far)).toBe(free);
        expect(entrain(p, far, 0)).toBe(free);
        // corner
        const corner = entrain(p, reach, 0);
        expect(corner).toBeCloseTo(expectedEntrainment(p.q, p.q * (1 - p.chi), p.area, p.z, 4), 9);
        // Known limit: for a weak fire (Q* below about 0.2) the virtual origin z0 is far below the floor, and the
        // corner value (larger D, so a larger z - z0 before the division by 4) can exceed the free value, e.g.
        // Q = 10 kW, A = 1 m2, z = 0.1 m gives 0.218 kg/s in the corner and 0.183 kg/s free. This follows from
        // Tech Ref eq. 3.17/3.18 and CFAST 7.7.7. The generator keeps Q* >= 0.2.
        expect(corner).toBeLessThanOrEqual(free * (1 + 1e-9));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Steckler positions: 0.3 m diameter burner in a 2.8 m room.
  const steckler = { q: 62.9e3, chi: 0.3, area: (Math.PI / 4) * 0.3 ** 2, z: 1.0 };
  it('centre and single-wall positions give the free-plume value, a corner gives the corner value', () => {
    const half = 1.4;
    const wallX = Math.sqrt(steckler.area) / 2;
    const free = expectedEntrainment(steckler.q, steckler.q * 0.7, steckler.area, steckler.z, 1);
    expect(mirrorFactor(half, half, steckler.area)).toBe(1);
    expect(mirrorFactor(wallX, half, steckler.area)).toBe(1);
    expect(mirrorFactor(wallX, wallX, steckler.area)).toBe(4);
    expect(entrain(steckler, half, half)).toBeCloseTo(free, 12);
    expect(entrain(steckler, wallX, half)).toBeCloseTo(free, 12);
    const corner = entrain(steckler, wallX, wallX);
    expect(corner).toBeCloseTo(expectedEntrainment(steckler.q, steckler.q * 0.7, steckler.area, steckler.z, 4), 12);
    expect(corner).toBeLessThan(free);
  });

  it('Eq. 3.17 matches a hand calculation (Tech Ref form)', () => {
    // Qc = 100 kW, dz = 2 m, T = 293.15 K, rho = 352.981915 / T, cp = 1.012 kJ/(kg K)
    const rho = 352.981915 / T_AMB;
    const g = 9.80665;
    const cp = 1.012;
    const qc = 100;
    const dz = 2;
    const handM =
      0.196 * ((g * rho * rho) / (cp * T_AMB)) ** (1 / 3) * qc ** (1 / 3) * dz ** (5 / 3) *
      (1 + (2.9 * qc ** (2 / 3)) / ((Math.sqrt(g) * cp * rho * T_AMB) ** (2 / 3) * dz ** (5 / 3)));
    expect(entrainmentEq317(qc, dz, T_AMB)).toBeCloseTo(handM, 10);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------------------------

describe('combustion products', () => {
  // Feature: fire-zone, Property 17: Combustion products balance the elements
  // **Validates: Requirements 6.11**
  it('Property 17: C, H, O and total mass balance within 1 %', () => {
    fc.assert(
      fc.property(arbFuel, arbYields, fc.double({ min: 1e-4, max: 1, noNaN: true }), (fuel, yields, burned) => {
        const mF = fuelMolarMassKgPerMol(fuel);
        const nu = stoichiometry(fuel, { ...yields, hcnYield: 0 });
        const r = speciesRates(burned, fuel, nu);
        const near = (a: number, b: number): void => {
          expect(Math.abs(a - b)).toBeLessThanOrEqual(0.01 * Math.max(Math.abs(a), Math.abs(b)) + 1e-12);
        };
        // carbon (CO2, CO, soot as carbon)
        const cOut =
          (r.co2 * ATOMIC_MASS_C_KG_PER_MOL) / MOLAR_MASS_CO2_KG_PER_MOL +
          (r.co * ATOMIC_MASS_C_KG_PER_MOL) / MOLAR_MASS_CO_KG_PER_MOL +
          r.soot;
        near(cOut, (burned * fuel.c * ATOMIC_MASS_C_KG_PER_MOL) / mF);
        // hydrogen (H2O)
        const hOut = (r.h2o * 2 * ATOMIC_MASS_H_KG_PER_MOL) / MOLAR_MASS_H2O_KG_PER_MOL;
        near(hOut, (burned * fuel.h * ATOMIC_MASS_H_KG_PER_MOL) / mF);
        // oxygen: consumed O2 plus fuel oxygen equals oxygen in CO2, CO, H2O
        const oIn = -r.o2 + (burned * fuel.o * ATOMIC_MASS_O_KG_PER_MOL) / mF;
        const oOut =
          (r.co2 * 2 * ATOMIC_MASS_O_KG_PER_MOL) / MOLAR_MASS_CO2_KG_PER_MOL +
          (r.co * ATOMIC_MASS_O_KG_PER_MOL) / MOLAR_MASS_CO_KG_PER_MOL +
          (r.h2o * ATOMIC_MASS_O_KG_PER_MOL) / MOLAR_MASS_H2O_KG_PER_MOL;
        near(oIn, oOut);
        // total mass: fuel + O2 = products (nitrogen reverts to N2)
        const products = r.co2 + r.co + r.h2o + r.soot + r.hcl + r.hcn + r.n2;
        near(burned - r.o2, products);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// cfastUpperPlumeArgOrder
// ---------------------------------------------------------------------------------------------

describe('upper plume argument order (Requirement 6.13)', () => {
  const fuel = { c: 3, h: 4, o: 1, n: 0, cl: 0, heatOfCombustionJPerKg: 2.5e7 };
  const mkFire = (hrrW: number, xM: number, yM: number): Fire => ({
    id: 'f', compartmentId: 'c', xM, yM, radiativeFraction: 0.3, fuel,
    table: [
      { timeS: 0, hrrW, heightM: 0, areaM2: 1, coYield: 0.01, sootYield: 0.02 },
      { timeS: 100, hrrW, heightM: 0, areaM2: 1, coYield: 0.01, sootYield: 0.02 },
    ],
  });
  const room = { widthM: 4, depthM: 4, heightM: 3 };
  const base = {
    room, lowerTempK: T_AMB, upperTempK: 400, lowerMassKg: 40, minLowerMassKg: 0.01,
    interiorAmbientTempK: T_AMB,
  };

  it('upperPlumeArgs puts the arguments into swapped slots only for the CFAST order', () => {
    const inputs = { plumeHeightM: 1.5, fireAreaM2: 1, xWallDistM: 0.7, yWallDistM: 1.9 };
    expect(upperPlumeArgs(inputs, false)).toEqual({ heightM: 1.5, fireAreaM2: 1, xWallDistM: 0.7, yWallDistM: 1.9 });
    expect(upperPlumeArgs(inputs, true)).toEqual({ fireAreaM2: 1.5, xWallDistM: 1, yWallDistM: 0.7, heightM: 1.9 });
  });

  it('settings differ for an oxygen-limited fire and match the hand calculation with swapped slots', () => {
    const fire = mkFire(2e6, 0.7, 1.9);
    const drive = fireDrive(fire, 10, false);
    const input = {
      ...base, fire, drive, upperLayerDepthM: 0.1,
      o2Lower: 0.10, // below the limit: nothing burns below, all fuel goes to the upper layer
      o2Upper: 0.16,
    };
    const intended = evaluateFire({ ...input, cfastUpperPlumeArgOrder: false });
    const cfast = evaluateFire({ ...input, cfastUpperPlumeArgOrder: true });
    expect(intended.hrrLowerW).toBe(0);
    expect(cfast.hrrLowerW).toBe(0);
    expect(cfast.entrainmentUpperKgS).not.toBe(intended.entrainmentUpperKgS);
    expect(cfast.hrrUpperW).not.toBe(intended.hrrUpperW);

    // Hand calculation. hrrTotal = Q (nothing burned below), Qc = Q (1 - chi).
    const hrr = drive.pyrolysisKgS * drive.hocJPerKg;
    const call = (area: number, x: number, y: number, z: number): number =>
      heskestadEntrainment({
        totalHrrW: hrr, convectiveHrrW: hrr * 0.7, fireAreaM2: area, xWallDistM: x, yWallDistM: y,
        heightM: z, ambientTempK: T_AMB, pyrolysisKgS: drive.pyrolysisKgS,
      }).entrainmentKgS;
    // The plume sees (x, y) distances as min(x, w - x) and min(y, d - y).
    const xD = 0.7;
    const yD = 1.9; // min(1.9, 4 - 1.9)
    const yDist = Math.min(1.9, 4 - 1.9);
    expect(yDist).toBe(yD);
    expect(intended.entrainmentUpperKgS).toBeCloseTo(call(drive.areaM2, xD, yDist, 0.1), 12);
    // swapped: area slot = plume height 0.1, x slot = area, y slot = x distance, height slot = y distance
    expect(cfast.entrainmentUpperKgS).toBeCloseTo(call(0.1, drive.areaM2, xD, yDist), 12);
  });

  it('settings agree for a lower-layer-only fire', () => {
    const fire = mkFire(50e3, 2, 2);
    const drive = fireDrive(fire, 10, false);
    const input = { ...base, fire, drive, upperLayerDepthM: 0.5, o2Lower: 0.23, o2Upper: 0.23 };
    const a = evaluateFire({ ...input, cfastUpperPlumeArgOrder: false });
    const b = evaluateFire({ ...input, cfastUpperPlumeArgOrder: true });
    expect(a.hrrUpperW).toBe(0);
    expect(b.hrrUpperW).toBe(0);
    expect(a.hrrW).toBe(b.hrrW);
    expect(a.entrainmentKgS).toBe(b.entrainmentKgS);
    expect(a.upperLayerRates).toEqual(b.upperLayerRates);
  });
});
