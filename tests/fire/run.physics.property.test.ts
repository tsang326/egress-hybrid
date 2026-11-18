// Full-run physical property tests (tasks.md 10.5; Requirement 14).
// Every property here drives `runFire` end to end on small generated scenarios.
//
// What the Result exposes limits some checks, and the tests say where:
//  - no surface temperatures or wall fluxes (Property 30 checks gas temperature and pressure only);
//  - no wall heat absorption (Property 31 checks the energy balance on closed rooms whose surfaces are adiabatic, so the
//    wall term is exactly zero; the mass balance runs on every generated Scenario);
//  - no nitrogen or unburned-fuel fraction (Property 29 checks that the five reported fractions are in [0, 1] and sum to
//    at most 1 + 1e-6).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CP_J_PER_KG_K, GAS_R_J_PER_KG_K, GAMMA, LOWER_OXYGEN_LIMIT, RTOL } from "../../src/core/fire/constants";
import { runFire } from "../../src/core/fire";
import type {
  Compartment,
  CompartmentSeries,
  Fire,
  HrrRow,
  LayerSeries,
  Result,
  Scenario,
  Surface,
  Vent,
} from "../../src/core/fire/types";
import { arbScenario, withTimeLimit } from "./arbitraries";

const NUM_RUNS = 100;

const ADIABATIC: Surface = { adiabatic: true };

// --- helpers ---------------------------------------------------------------------------------------------------------

/** Small and quick: at most 60 s, so 100 runs stay well inside the test timeout. */
const arbSmall = (opts: Parameters<typeof arbScenario>[0] = {}): fc.Arbitrary<Scenario> =>
  arbScenario({ maxCompartments: 2, maxFires: 1, maxVents: 2, ...opts }).map((s) => {
    const durationS = Math.min(s.durationS, 60);
    return { ...s, durationS, printIntervalS: Math.min(s.printIntervalS, durationS) };
  });

function runChecked(s: Scenario): Result {
  const r = withTimeLimit(() => runFire(s));
  expect(r.warnings.filter((w) => r.status !== "ok").map((w) => w.message)).toEqual([]);
  expect(r.status).toBe("ok");
  return r;
}

const sampleCount = (r: Result): number => r.timesS.length;

/** Piecewise-linear table value with the first and last rows held (Requirement 6.3, 6.4). */
function tableValue(table: HrrRow[], t: number): number {
  const first = table[0] as HrrRow;
  const last = table[table.length - 1] as HrrRow;
  if (t <= first.timeS) return first.hrrW;
  if (t >= last.timeS) return last.hrrW;
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1] as HrrRow;
    const b = table[i] as HrrRow;
    if (t <= b.timeS) return a.hrrW + ((b.hrrW - a.hrrW) * (t - a.timeS)) / (b.timeS - a.timeS);
  }
  return last.hrrW;
}

/** Exact integral of the held, piecewise-linear table from 0 to t. */
function tableIntegral(table: HrrRow[], t: number): number {
  let sum = 0;
  let prevT = 0;
  let prevV = tableValue(table, 0);
  const knots = table.map((r) => r.timeS).filter((x) => x > 0 && x < t);
  for (const k of [...knots, t]) {
    const v = tableValue(table, k);
    sum += 0.5 * (prevV + v) * (k - prevT);
    prevT = k;
    prevV = v;
  }
  return sum;
}

function gasMassKg(c: Compartment, s: CompartmentSeries, k: number): number {
  const p = s.pressurePa[k] as number;
  const vu = s.upperVolumeM3[k] as number;
  const vTotal = c.widthM * c.depthM * c.heightM;
  return (p / GAS_R_J_PER_KG_K) * (vu / (s.upperTempK[k] as number) + (vTotal - vu) / (s.lowerTempK[k] as number));
}

/** Total gas energy U = sum cv m T = P V / (gamma - 1) for an ideal gas, J (Tech Ref eq. 2.1). */
function gasEnergyJ(c: Compartment, s: CompartmentSeries, k: number): number {
  return ((s.pressurePa[k] as number) * (c.widthM * c.depthM * c.heightM)) / (GAMMA - 1);
}

function layerOk(l: LayerSeries, k: number): string | null {
  const parts = [l.o2[k], l.co2[k], l.co[k], l.h2o[k], l.soot[k]] as number[];
  let sum = 0;
  for (const x of parts) {
    if (!Number.isFinite(x) || x < 0 || x > 1) return `fraction ${x} outside [0, 1]`;
    sum += x;
  }
  if (sum > 1 + 1e-6) return `fractions sum to ${sum}`;
  const od = l.opticalDensityPerM[k] as number;
  const vis = l.visibilityM[k] as number;
  if (Number.isNaN(od) || Number.isNaN(vis)) return "NaN smoke value";
  return null;
}

// --- Property 29 -----------------------------------------------------------------------------------------------------

// 100 full runs per property; each run has its own 10 s limit (withTimeLimit), this is only the Vitest ceiling.
describe("full-run physical properties", { timeout: 1_200_000 }, () => {
  it("Property 29: physical invariants of full runs", () => {
    // Feature: fire-zone, Property 29: Physical invariants of full runs
    // **Validates: Requirements 14.4, 14.9, 14.10**
    fc.assert(
      fc.property(arbScenario(), (s) => {
        const r = withTimeLimit(() => runFire(s));
        expect(r.status).toBe("ok");
        expect(sampleCount(r)).toBeGreaterThan(0);
        for (const t of r.timesS) expect(Number.isNaN(t)).toBe(false);
        s.compartments.forEach((c, i) => {
          const cs = r.compartments[i] as CompartmentSeries;
          for (let k = 0; k < sampleCount(r); k++) {
            const z = cs.interfaceHeightM[k] as number;
            expect(z >= 0 && z <= c.heightM).toBe(true);
            for (const T of [cs.upperTempK[k], cs.lowerTempK[k]] as number[]) {
              expect(Number.isFinite(T) && T > 0).toBe(true);
            }
            expect(Number.isFinite(cs.pressurePa[k] as number)).toBe(true);
            expect(Number.isNaN(cs.upperVolumeM3[k] as number)).toBe(false);
            expect(layerOk(cs.upper, k)).toBeNull();
            expect(layerOk(cs.lower, k)).toBeNull();
            for (const b of cs.burnedHrrW) expect(Number.isFinite(b.values[k] as number)).toBe(true);
          }
        });
        for (const v of r.vents) {
          for (const e of v.ends) {
            for (const a of [e.upperInKgS, e.upperOutKgS, e.lowerInKgS, e.lowerOutKgS]) {
              for (const x of a) expect(Number.isFinite(x)).toBe(true);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Property 30 ---------------------------------------------------------------------------------------------------

  it("Property 30: no fire at ambient stays at ambient", () => {
    // Feature: fire-zone, Property 30: No fire at ambient stays at ambient
    // **Validates: Requirements 7.7, 14.1**
    const arbAmbientCase = fc.tuple(arbSmall({ maxFires: 1 }), fc.integer({ min: 255, max: 315 }));
    fc.assert(
      fc.property(arbAmbientCase, ([base, tempK]) => {
        const s: Scenario = {
          ...base,
          fires: [],
          ambient: { ...base.ambient, interiorTempK: tempK, exteriorTempK: tempK },
        };
        const r = runChecked(s);
        r.compartments.forEach((cs) => {
          const p0 = cs.pressurePa[0] as number;
          for (let k = 0; k < sampleCount(r); k++) {
            for (const T of [cs.upperTempK[k], cs.lowerTempK[k]] as number[]) {
              expect(Math.abs(T - tempK) / tempK).toBeLessThanOrEqual(1e-6);
            }
            expect(Math.abs((cs.pressurePa[k] as number) - p0) / p0).toBeLessThanOrEqual(1e-6);
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Property 31 ---------------------------------------------------------------------------------------------------

  it("Property 31: mass balance in full runs", () => {
    // Feature: fire-zone, Property 31: Mass and energy balance in full runs (mass part)
    // **Validates: Requirements 14.2**
    fc.assert(
      fc.property(arbSmall({ maxFires: 2 }), (base) => {
        // Fine sampling keeps the trapezoid rule for the vent flows well below the 0.1 % tolerance.
        const s: Scenario = { ...base, printIntervalS: 0.25 };
        // Requirement 14.2: tolerance = max(0.1 % of the larger quantity, 10 x RTOL x initial gas mass, 1e-9 kg).
        const massCheck = (rtol: number | undefined): { maxErrKg: number; maxExcessKg: number } => {
          const r = withTimeLimit(() => runFire(s, rtol === undefined ? {} : { numerical: { rtol } }));
          expect(r.status).toBe("ok");
          const rtolUsed = rtol ?? RTOL;
          let cumInflow = 0;
          const m0 = s.compartments.reduce((sum, c, i) => sum + gasMassKg(c, r.compartments[i] as CompartmentSeries, 0), 0);
          const net = (k: number): number => {
            let q = 0;
            for (const v of r.vents) {
              if (v.ends[1].compartmentId !== "OUTSIDE") continue;
              const e = v.ends[0];
              q += (e.upperInKgS[k] as number) + (e.lowerInKgS[k] as number) - (e.upperOutKgS[k] as number) - (e.lowerOutKgS[k] as number);
            }
            return q;
          };
          let maxErrKg = 0;
          let maxExcessKg = -Infinity;
          for (let k = 1; k < sampleCount(r); k++) {
            const t = r.timesS[k] as number;
            cumInflow += 0.5 * (net(k - 1) + net(k)) * (t - (r.timesS[k - 1] as number));
            const fuelKg = s.fires.reduce((sum, f) => sum + tableIntegral(f.table, t) / f.fuel.heatOfCombustionJPerKg, 0);
            const m = s.compartments.reduce((sum, c, i) => sum + gasMassKg(c, r.compartments[i] as CompartmentSeries, k), 0);
            const lhs = m - m0;
            const rhs = cumInflow + fuelKg;
            const err = Math.abs(lhs - rhs);
            const tol = Math.max(1e-3 * Math.max(Math.abs(lhs), Math.abs(rhs)), 10 * rtolUsed * m0, 1e-9);
            maxErrKg = Math.max(maxErrKg, err);
            maxExcessKg = Math.max(maxExcessKg, err - tol);
          }
          return { maxErrKg, maxExcessKg };
        };
        const coarse = massCheck(undefined);
        expect(coarse.maxExcessKg).toBeLessThanOrEqual(0);
        // Convergence: RTOL 100 times smaller must cut the mass error at least 10-fold (or reach the 1e-9 kg floor).
        const fine = massCheck(RTOL / 100);
        expect(fine.maxExcessKg).toBeLessThanOrEqual(0);
        if (coarse.maxErrKg > 1e-9) {
          if (!(fine.maxErrKg <= coarse.maxErrKg / 10 || fine.maxErrKg <= 1e-9)) {
            throw new Error(`mass error did not converge: ${coarse.maxErrKg} kg at RTOL ${RTOL}, ${fine.maxErrKg} kg at RTOL ${RTOL / 100}`);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Property 31: energy balance in closed rooms with adiabatic surfaces", () => {
    // Feature: fire-zone, Property 31: Mass and energy balance in full runs (energy part)
    // **Validates: Requirements 14.3**
    // Closed room, every surface adiabatic: the wall term and the vent term are exactly zero, so the gas energy change
    // must equal the heat released plus the enthalpy of the unburned fuel, which the model adds at the interior ambient
    // temperature (design, Fire modules step 8; CFAST 7.7.7 source, fire.f90). The heat released is integrated from the
    // sampled Burned_HRR with the trapezoid rule; the HRR table times are put on the sample grid so that no kink of the
    // table falls between two samples.
    const dtS = 0.1;
    fc.assert(
      fc.property(arbSmall({ maxCompartments: 1, maxFires: 1, maxVents: 0 }), (base) => {
        const room: Compartment = { ...(base.compartments[0] as Compartment), ceiling: ADIABATIC, floor: ADIABATIC, walls: ADIABATIC };
        const durationS = Math.min(base.durationS, 20);
        const f0 = base.fires[0] as Fire;
        const scale = durationS / base.durationS;
        let lastK = -1;
        const table: HrrRow[] = f0.table.map((row) => {
          const k = Math.max(lastK + 1, Math.round((row.timeS * scale) / dtS));
          lastK = k;
          return { ...row, timeS: k * dtS };
        });
        const fire: Fire = { ...f0, table };
        const s: Scenario = { ...base, durationS, compartments: [room], vents: [], fires: [fire], printIntervalS: dtS };
        const r = runChecked(s);
        const cs = r.compartments[0] as CompartmentSeries;
        const tAmb = s.ambient.interiorTempK;
        const hc = fire.fuel.heatOfCombustionJPerKg;
        const e0 = gasEnergyJ(room, cs, 0);
        const burn = cs.burnedHrrW[0]?.values as Float64Array;
        // Unburned fuel rate (kg/s) at sample k: pyrolysis (table / Hc) minus the fuel that burned (Burned_HRR / Hc).
        const unburned = (k: number): number => (tableValue(table, r.timesS[k] as number) - (burn[k] as number)) / hc;
        let released = 0;
        let fuelEnthalpy = 0;
        for (let k = 1; k < sampleCount(r); k++) {
          const h = (r.timesS[k] as number) - (r.timesS[k - 1] as number);
          released += 0.5 * ((burn[k - 1] as number) + (burn[k] as number)) * h;
          fuelEnthalpy += 0.5 * CP_J_PER_KG_K * tAmb * (unburned(k - 1) + unburned(k)) * h;
          const dE = gasEnergyJ(room, cs, k) - e0;
          const diff = Math.abs(released + fuelEnthalpy - dE);
          if (released < 1e-3) expect(diff).toBeLessThanOrEqual(1e-3);
          else expect(diff).toBeLessThanOrEqual(0.01 * released);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Property 32 ---------------------------------------------------------------------------------------------------

  it("Property 32: closed room with a fire consumes oxygen", () => {
    // Feature: fire-zone, Property 32: Closed room with a fire consumes oxygen
    // **Validates: Requirements 14.5**
    fc.assert(
      fc.property(arbSmall({ maxCompartments: 1, maxFires: 1, maxVents: 0 }), (base) => {
        const fire = base.fires[0] as Fire;
        fc.pre(tableIntegral(fire.table, base.durationS) > 0);
        const r = runChecked(base);
        const cs = r.compartments[0] as CompartmentSeries;
        const last = sampleCount(r) - 1;
        expect(cs.upper.o2[last] as number).toBeLessThan(cs.upper.o2[0] as number);
        let limitReached = false;
        const burned = cs.burnedHrrW[0]?.values as Float64Array;
        for (let k = 0; k <= last; k++) {
          if ((cs.lower.o2[k] as number) <= LOWER_OXYGEN_LIMIT) limitReached = true;
          if (!limitReached) continue;
          const table = tableValue(fire.table, r.timesS[k] as number);
          if (table > 0) expect(burned[k] as number).toBeLessThan(table);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Property 33 ---------------------------------------------------------------------------------------------------

  it("Property 33: mirror symmetry", () => {
    // Feature: fire-zone, Property 33: Mirror symmetry
    // **Validates: Requirements 14.6**
    const arbMirror = fc.record({
      base: arbSmall({ maxCompartments: 1, maxFires: 1, maxVents: 1 }),
      face: fc.constantFrom("left", "right" as const),
    });
    fc.assert(
      fc.property(arbMirror, ({ base, face }) => {
        const room = base.compartments[0] as Compartment;
        const fire = base.fires[0] as Fire;
        const other = face === "left" ? "right" : "left";
        const a: Compartment = { ...room, id: "a" };
        const b: Compartment = { ...room, id: "b" };
        // Exact mirror in floating point: xB = fl(W - x) and xA = W - xB, which is exact (Sterbenz), so W - xA == xB and
        // W - xB == xA bit for bit. With xA = x the rounding of W - x would make the two rooms differ by 1 ulp.
        const xB = room.widthM - Math.min(fire.xM, room.widthM - fire.xM);
        const xA = room.widthM - xB;
        const fireA: Fire = { ...fire, id: "fa", compartmentId: "a", xM: xA };
        const fireB: Fire = { ...fire, id: "fb", compartmentId: "b", xM: xB };
        const vents: Vent[] = [];
        const v = base.vents[0];
        if (v !== undefined && v.kind === "wall") {
          const wallLen = room.depthM;
          const width = Math.min(v.widthM, wallLen);
          const shared = { kind: "wall" as const, to: "OUTSIDE", sillM: v.sillM, soffitM: v.soffitM, widthM: width, offsetM: 0, open: v.open };
          vents.push({ ...shared, id: "va", from: "a", face });
          vents.push({ ...shared, id: "vb", from: "b", face: other });
        }
        const s: Scenario = { ...base, compartments: [a, b], fires: [fireA, fireB], vents };
        const r = runChecked(s);
        const [ca, cb] = r.compartments as [CompartmentSeries, CompartmentSeries];
        const close = (x: number, y: number, what: string): void => {
          if (x === y) return; // also covers equal infinities
          const scale = Math.max(Math.abs(x), Math.abs(y));
          const ok = Math.abs(x - y) <= 1e-9 * scale + 1e-14;
          if (!ok) throw new Error(`${what}: ${x} vs ${y}`);
        };
        const layers = ["upper", "lower"] as const;
        for (let k = 0; k < sampleCount(r); k++) {
          close(ca.upperTempK[k] as number, cb.upperTempK[k] as number, `Tu[${k}]`);
          close(ca.lowerTempK[k] as number, cb.lowerTempK[k] as number, `Tl[${k}]`);
          close(ca.interfaceHeightM[k] as number, cb.interfaceHeightM[k] as number, `z[${k}]`);
          close(ca.pressurePa[k] as number, cb.pressurePa[k] as number, `P[${k}]`);
          close(ca.upperVolumeM3[k] as number, cb.upperVolumeM3[k] as number, `Vu[${k}]`);
          close((ca.burnedHrrW[0]?.values[k] ?? 0) as number, (cb.burnedHrrW[0]?.values[k] ?? 0) as number, `hrr[${k}]`);
          for (const L of layers) {
            for (const q of ["o2", "co2", "co", "h2o", "soot", "opticalDensityPerM", "visibilityM"] as const) {
              close(ca[L][q][k] as number, cb[L][q][k] as number, `${L}.${q}[${k}]`);
            }
          }
        }
        if (r.vents.length === 2) {
          const [va, vb] = r.vents as [Result["vents"][number], Result["vents"][number]];
          for (let k = 0; k < sampleCount(r); k++) {
            for (const q of ["upperInKgS", "upperOutKgS", "lowerInKgS", "lowerOutKgS"] as const) {
              close(va.ends[0][q][k] as number, vb.ends[0][q][k] as number, `vent.${q}[${k}]`);
              close(va.ends[1][q][k] as number, vb.ends[1][q][k] as number, `vent.end1.${q}[${k}]`);
            }
            close(va.openFraction[k] as number, vb.openFraction[k] as number, `open[${k}]`);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Property 34 ---------------------------------------------------------------------------------------------------

  it("Property 34: HRR monotonicity", () => {
    // Feature: fire-zone, Property 34: HRR monotonicity
    // **Validates: Requirements 14.8**
    const arbPair = fc
      .tuple(fc.integer({ min: 1, max: 250 }), fc.integer({ min: 1, max: 250 }))
      .map(([q, extra]) => [q * 1000, (q + extra) * 1000] as const);
    fc.assert(
      fc.property(arbSmall({ maxCompartments: 1, maxFires: 1, maxVents: 2 }), arbPair, (base, [q1, q2]) => {
        // Requirement 14.8 is stated for steady-state Scenarios: constant HRR and constant vent openings. A vent with an
        // open-fraction table is replaced by its first fraction.
        const vents: Vent[] = base.vents.map((v) =>
          v.kind === "wall" && typeof v.open !== "number" ? { ...v, open: v.open.fractions[0] as number } : v,
        );
        // A room without a vent cannot reach a steady state with a fire, so it gets a fully open doorway to the Outside.
        if (vents.length === 0) {
          const room = base.compartments[0] as Compartment;
          vents.push({ kind: "wall", id: "door", from: room.id, to: "OUTSIDE", sillM: 0, soffitM: Math.min(2, room.heightM), widthM: 0.8, face: "front", offsetM: 0, open: 1 });
        }
        const withHrr = (q: number): Scenario => {
          const fire = base.fires[0] as Fire;
          const table: HrrRow[] = [
            { timeS: 0, hrrW: q, heightM: 0.3, areaM2: 0.5, coYield: 0.01, sootYield: 0.02 },
            { timeS: base.durationS, hrrW: q, heightM: 0.3, areaM2: 0.5, coYield: 0.01, sootYield: 0.02 },
          ];
          return { ...base, vents, fires: [{ ...fire, table }] };
        };
        const lo = runChecked(withHrr(q1));
        const hi = runChecked(withHrr(q2));
        // Steady state also needs a well-ventilated fire: both runs burn their full table HRR at every sample. An
        // oxygen-limited fire (closed or nearly closed room) is not steady, so the pair is discarded, not checked.
        const fullyBurning = (r: Result, q: number): boolean =>
          ((r.compartments[0] as CompartmentSeries).burnedHrrW[0]?.values ?? new Float64Array(0)).every((v) => v >= q * (1 - 1e-9));
        fc.pre(fullyBurning(lo, q1) && fullyBurning(hi, q2));
        const a = (lo.compartments[0] as CompartmentSeries).upperTempK;
        const b = (hi.compartments[0] as CompartmentSeries).upperTempK;
        expect(sampleCount(hi)).toBe(sampleCount(lo));
        const strict = q2 - q1 >= 0.1 * q1;
        // Compared at the end of the run only (design.md Property 34): transients can lag differently for the two fires.
        const last = a.length - 1;
        expect(b[last] as number).toBeGreaterThanOrEqual(a[last] as number);
        if (strict) expect(b[last] as number).toBeGreaterThan(a[last] as number);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
