// Heat release of a fire (Tech Ref section 3.2, eq. 3.10, 3.11, 3.13 to 3.15) with the evaluation order of
// CFAST 7.7.7 (fire.f90: interpolate_pyrolysis, do_fire, chemistry). Pure functions, SI units.
import {
  FIRE_MAX_PASSES,
  FIRE_PASS_TOL,
  HEAT_OF_COMBUSTION_MAX_J_PER_KG,
  HEAT_OF_COMBUSTION_MIN_J_PER_KG,
  HEAT_PER_KG_OXYGEN_J_PER_KG,
  LOWER_OXYGEN_LIMIT,
  MIN_FIRE_AREA_M2,
  OXYGEN_TANH_OFFSET,
  OXYGEN_TANH_SCALE,
  OXYGEN_TANH_SHIFT,
  OXYGEN_TANH_SLOPE,
} from "../constants";
import type { Fire, HrrRow } from "../types";
import {
  addRates,
  fuelMolarMassKgPerMol,
  scaleRates,
  speciesRates,
  stoichiometry,
  zeroRates,
  type FuelAtoms,
  type SpeciesRates,
} from "./chemistry";
import { heskestadEntrainment, limitEntrainment, upperPlumeArgs } from "./plume";

// CFAST 7.7.7 source, fire.f90 (interpolate_pyrolysis, tfilter_max): length of the adiabatic start-up ramp, s.
const ADIABATIC_RAMP_S = 1;

// ---------------------------------------------------------------------------------------------
// Table interpolation (Requirements 6.3, 6.4)
// ---------------------------------------------------------------------------------------------

const EMPTY_ROW: HrrRow = { timeS: 0, hrrW: 0, heightM: 0, areaM2: 0, coYield: 0, sootYield: 0 };

// Requirement 6.3: linear interpolation of every column. Requirement 6.4: after the last row the last row holds.
// Before the first row the first row holds (CFAST 7.7.7 source, utilities.f90, interp, extrapolation code 1).
// An empty table gives an all-zero row (the Input_Validator rejects it before a run).
export function interpolateRow(table: readonly HrrRow[], tableTimeS: number): HrrRow {
  const n = table.length;
  const first = table[0];
  const last = table[n - 1];
  if (first === undefined || last === undefined) return { ...EMPTY_ROW, timeS: tableTimeS };
  if (!(tableTimeS > first.timeS)) return { ...first };
  if (tableTimeS >= last.timeS) return { ...last };
  // Binary search for the segment [lo, lo + 1] containing the time.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const row = table[mid];
    if (row !== undefined && row.timeS <= tableTimeS) lo = mid;
    else hi = mid;
  }
  const a = table[lo];
  const b = table[hi];
  if (a === undefined || b === undefined) return { ...first };
  const span = b.timeS - a.timeS;
  const f = span > 0 ? (tableTimeS - a.timeS) / span : 0;
  const mix = (x: number, y: number): number => x + f * (y - x);
  return {
    timeS: tableTimeS,
    hrrW: mix(a.hrrW, b.hrrW),
    heightM: mix(a.heightM, b.heightM),
    areaM2: mix(a.areaM2, b.areaM2),
    coYield: mix(a.coYield, b.coYield),
    sootYield: mix(a.sootYield, b.sootYield),
  };
}

// CFAST 7.7.7 source, input_namelist.f90 (set_heat_of_combustion): rows with positive HRR use the heat of combustion
// clamped to [1e6, 1e8] J/kg. Rows with zero HRR keep the input value (no fuel burns there, so it has no effect).
export function clampHeatOfCombustion(hocJPerKg: number): number {
  return Math.min(HEAT_OF_COMBUSTION_MAX_J_PER_KG, Math.max(HEAT_OF_COMBUSTION_MIN_J_PER_KG, hocJPerKg));
}

// What a fire is asking for at one instant, before the oxygen limit.
export interface FireDrive {
  active: boolean;
  hrrW: number; // table HRR, after the adiabatic ramp
  pyrolysisKgS: number; // eq. 3.13
  hocJPerKg: number; // clamped
  heightM: number; // base of the fire above the floor
  areaM2: number; // at least the minimum fire area
  coYield: number;
  sootYield: number;
}

const INACTIVE_DRIVE: FireDrive = {
  active: false, hrrW: 0, pyrolysisKgS: 0, hocJPerKg: 0, heightM: 0, areaM2: 0, coYield: 0, sootYield: 0,
};

// Ignition (design Fire modules step 1), table interpolation (step 2), eq. 3.13 with the clamped heat of combustion
// and minimum area (step 3), and the adiabatic 1 s ramp (step 4; CFAST 7.7.7 source, fire.f90, interpolate_pyrolysis,
// which scales mdot and qdot by min(t, 1 s) / 1 s on the simulation time, not the table time).
// The fire is inactive (all rates zero) before its ignition time.
export function fireDrive(fire: Fire, timeS: number, adiabatic: boolean): FireDrive {
  const ignitionS = fire.ignitionTimeS ?? 0;
  if (!(timeS >= ignitionS) || fire.table.length === 0) return INACTIVE_DRIVE;
  const row = interpolateRow(fire.table, timeS - ignitionS);
  const hoc = row.hrrW > 0 ? clampHeatOfCombustion(fire.fuel.heatOfCombustionJPerKg) : fire.fuel.heatOfCombustionJPerKg;
  const ramp = adiabatic ? Math.min(Math.max(timeS, 0), ADIABATIC_RAMP_S) / ADIABATIC_RAMP_S : 1;
  const hrrW = Math.max(row.hrrW, 0) * ramp;
  return {
    active: true,
    hrrW,
    pyrolysisKgS: hoc > 0 ? hrrW / hoc : 0, // Tech Ref eq. 3.13
    hocJPerKg: hoc,
    heightM: Math.max(row.heightM, 0),
    areaM2: Math.max(row.areaM2, MIN_FIRE_AREA_M2), // CFAST 7.7.7 source, cfast_structures.f90, pop_table
    coYield: row.coYield,
    sootYield: row.sootYield,
  };
}

// Tech Ref eq. 3.10, 3.11: radiative and convective parts of a heat release rate. The radiative fraction is clamped to
// [0, 1] as CFAST does (fire.f90, do_fire).
export function radiativeConvective(hrrW: number, radiativeFraction: number): { radiativeW: number; convectiveW: number } {
  const chi = Math.max(Math.min(radiativeFraction, 1), 0);
  return { radiativeW: hrrW * chi, convectiveW: Math.max(hrrW * (1 - chi), 0) };
}

// ---------------------------------------------------------------------------------------------
// Oxygen limit
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 3.15 (same shape) in the form CFAST 7.7.7 uses (utilities.f90, tanhsmooth, called from fire.f90, chemistry):
// clamp(0.5 + 0.5025 tanh(600 (Y - 0.15) - 3), 0, 1). Exactly 0 at Y <= 0.15 and exactly 1 at Y >= 0.16.
// A non-finite oxygen fraction gives 0 (no burning).
export function oxygenFactor(o2MassFraction: number): number {
  if (!Number.isFinite(o2MassFraction)) return 0;
  const f =
    OXYGEN_TANH_OFFSET +
    OXYGEN_TANH_SCALE * Math.tanh(OXYGEN_TANH_SLOPE * (o2MassFraction - LOWER_OXYGEN_LIMIT) - OXYGEN_TANH_SHIFT);
  return Math.min(Math.max(f, 0), 1);
}

export interface BurnInput {
  pyrolysisKgS: number; // fuel available to burn
  hocJPerKg: number;
  entrainmentKgS: number;
  sourceO2: number; // oxygen mass fraction in the layer that supplies the fire
  fuel: FuelAtoms;
  coYield: number;
  sootYield: number;
}

export interface BurnResult {
  hrrW: number; // burned HRR
  burnedFuelKgS: number;
  rates: SpeciesRates; // fuel and O2 negative, products positive
}

// Tech Ref eq. 3.14 and CFAST 7.7.7 source, fire.f90, chemistry:
//   available O2 = m_e Y_O2 C_LOL; Q = max(0, min(m_f dH, available O2 * 1.31e7 J/kg)).
// Then the stoichiometry of eq. 3.1 to 3.9 gives the product rates for the burned fuel. If the O2 those need exceeds the
// available O2, all rates are scaled down by the ratio (CFAST 7.7.7 source, fire.f90, chemistry, "factor").
// Guarantees 0 <= hrrW <= pyrolysisKgS * hocJPerKg (Requirement 6.9) and hrrW = 0 when Y_O2 <= 0.15 (Requirement 6.8).
export function burn(input: BurnInput): BurnResult {
  const { pyrolysisKgS, hocJPerKg, entrainmentKgS, sourceO2, fuel } = input;
  if (!(pyrolysisKgS > 0) || !(hocJPerKg > 0)) return { hrrW: 0, burnedFuelKgS: 0, rates: zeroRates() };
  const o2Available = Math.max(entrainmentKgS, 0) * sourceO2 * oxygenFactor(sourceO2); // kg/s, eq. 3.14
  let hrrW = Math.max(0, Math.min(pyrolysisKgS * hocJPerKg, o2Available * HEAT_PER_KG_OXYGEN_J_PER_KG));
  let burnedFuelKgS = hrrW / hocJPerKg;
  const nu = stoichiometry(fuel, { coYield: input.coYield, sootYield: input.sootYield, hcnYield: 0 });
  let rates = speciesRates(burnedFuelKgS, fuel, nu);
  if (-rates.o2 > o2Available && rates.o2 < 0) {
    const factor = -o2Available / rates.o2;
    burnedFuelKgS *= factor;
    hrrW *= factor;
    rates = scaleRates(rates, factor);
  }
  return { hrrW, burnedFuelKgS, rates };
}

// ---------------------------------------------------------------------------------------------
// One fire, one evaluation (lower-layer passes, then upper-layer burning)
// ---------------------------------------------------------------------------------------------

export interface FireEvalInput {
  fire: Pick<Fire, "xM" | "yM" | "radiativeFraction" | "fuel">;
  drive: FireDrive;
  room: { widthM: number; depthM: number; heightM: number };
  upperLayerDepthM: number;
  lowerTempK: number;
  upperTempK: number;
  lowerMassKg: number;
  minLowerMassKg: number; // vmin * lower layer density
  o2Lower: number; // oxygen mass fraction, lower layer
  o2Upper: number; // oxygen mass fraction, upper layer
  interiorAmbientTempK: number;
  cfastUpperPlumeArgOrder?: boolean; // Requirement 6.13
}

export interface FireEvaluation {
  hrrW: number; // burned HRR, lower + upper
  hrrLowerW: number;
  hrrUpperW: number;
  convectiveW: number;
  radiativeW: number;
  pyrolysisKgS: number;
  burnedLowerKgS: number;
  burnedUpperKgS: number;
  unburnedFuelKgS: number; // carried to the upper layer as UHC
  entrainmentKgS: number; // lower layer to upper layer, from the lower-layer plume
  entrainmentUpperKgS: number; // plume entrainment used for the upper-layer burn only
  passes: number;
  // Product rates added to the upper layer. `fuel` is the unburned fuel added (positive); other entries as in SpeciesRates.
  upperLayerRates: SpeciesRates;
}

// Design Fire modules steps 5 to 9; CFAST 7.7.7 source, fire.f90, do_fire.
// Never throws. An inactive fire or a fire with no pyrolysis returns all zeros.
export function evaluateFire(input: FireEvalInput): FireEvaluation {
  const { fire, drive, room } = input;
  const result: FireEvaluation = {
    hrrW: 0, hrrLowerW: 0, hrrUpperW: 0, convectiveW: 0, radiativeW: 0, pyrolysisKgS: drive.pyrolysisKgS,
    burnedLowerKgS: 0, burnedUpperKgS: 0, unburnedFuelKgS: 0, entrainmentKgS: 0, entrainmentUpperKgS: 0,
    passes: 0, upperLayerRates: zeroRates(),
  };
  if (!drive.active || !(drive.pyrolysisKgS > 0) || !(drive.hocJPerKg > 0)) return result;

  const chi = Math.max(Math.min(fire.radiativeFraction, 1), 0);
  const xDistM = Math.min(fire.xM, room.widthM - fire.xM);
  const yDistM = Math.min(fire.yM, room.depthM - fire.yM);
  const pyro = drive.pyrolysisKgS;
  const hoc = drive.hocJPerKg;
  const yields = { coYield: drive.coYield, sootYield: drive.sootYield };

  let hrr = pyro * hoc;
  let hrrC = Math.max(hrr * (1 - chi), 0);
  let rates = zeroRates();
  let hrrLowerW = 0;
  let burnedLower = 0;
  let entrainmentKgS = 0;
  let passes = 0;

  // Lower-layer burning: the plume and chemistry are repeated, up to 5 passes, with the oxygen-constrained HRR
  // (CFAST 7.7.7 source, fire.f90, do_fire). Pyrolysis not burned here goes to the upper layer.
  const lowerPlumeHeightM = room.heightM - input.upperLayerDepthM - drive.heightM;
  if (lowerPlumeHeightM > 0) {
    while (passes < FIRE_MAX_PASSES) {
      passes++;
      const plume = heskestadEntrainment({
        totalHrrW: hrr, convectiveHrrW: hrrC, fireAreaM2: drive.areaM2, xWallDistM: xDistM, yWallDistM: yDistM,
        heightM: lowerPlumeHeightM, ambientTempK: input.interiorAmbientTempK, pyrolysisKgS: pyro,
      });
      entrainmentKgS = limitEntrainment(
        plume.entrainmentKgS, input.lowerMassKg, input.minLowerMassKg, hrrC, input.upperTempK, input.lowerTempK,
      );
      const b = burn({ pyrolysisKgS: pyro, hocJPerKg: hoc, entrainmentKgS, sourceO2: input.o2Lower, fuel: fire.fuel, ...yields });
      hrrLowerW = b.hrrW;
      burnedLower = b.burnedFuelKgS;
      rates = b.rates;
      if (Math.abs(hrr - b.hrrW) > FIRE_PASS_TOL) {
        hrr = b.hrrW;
        hrrC = b.hrrW * (1 - chi);
        continue;
      }
      break;
    }
  }

  // Upper-layer burning: the fuel not burned in the lower plume burns with upper-layer oxygen. The heat that drives the
  // upper plume is the lower-layer HRR plus what can be released here.
  const pyroUpper = Math.max(0, pyro - burnedLower);
  let hrrUpperW = 0;
  let burnedUpper = 0;
  let entrainmentUpperKgS = 0;
  if (pyroUpper > 0) {
    const hrrTotal = hoc * pyroUpper + hrrLowerW;
    const hrrConvective = hrrTotal * (1 - chi);
    const args = upperPlumeArgs(
      {
        plumeHeightM: Math.max(0, Math.min(input.upperLayerDepthM, room.heightM - drive.heightM)),
        fireAreaM2: drive.areaM2, xWallDistM: xDistM, yWallDistM: yDistM,
      },
      input.cfastUpperPlumeArgOrder === true,
    );
    const plume = heskestadEntrainment({
      totalHrrW: hrrTotal, convectiveHrrW: hrrConvective, fireAreaM2: args.fireAreaM2, xWallDistM: args.xWallDistM,
      yWallDistM: args.yWallDistM, heightM: args.heightM, ambientTempK: input.interiorAmbientTempK,
      pyrolysisKgS: pyroUpper,
    });
    entrainmentUpperKgS = plume.entrainmentKgS;
    const b = burn({ pyrolysisKgS: pyroUpper, hocJPerKg: hoc, entrainmentKgS: entrainmentUpperKgS, sourceO2: input.o2Upper, fuel: fire.fuel, ...yields });
    hrrUpperW = b.hrrW;
    burnedUpper = b.burnedFuelKgS;
    rates = addRates(rates, b.rates);
  }

  const hrrW = hrrLowerW + hrrUpperW;
  const unburned = Math.max(0, pyro - burnedLower - burnedUpper);
  const split = radiativeConvective(hrrW, chi);
  return {
    ...result,
    hrrW, hrrLowerW, hrrUpperW,
    convectiveW: split.convectiveW, radiativeW: split.radiativeW,
    burnedLowerKgS: burnedLower, burnedUpperKgS: burnedUpper, unburnedFuelKgS: unburned,
    entrainmentKgS, entrainmentUpperKgS, passes,
    // Unburned fuel is added to the upper layer as UHC; products are the sum of both burns.
    upperLayerRates: { ...rates, fuel: unburned },
  };
}

// Re-exported for callers that need the fuel molar mass with the same atomic masses (eq. 3.2 to 3.4).
export { fuelMolarMassKgPerMol };
