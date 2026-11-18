// Absorption coefficient of a gas layer (CO2, H2O and soot) and beam transmittance.
// Sources: Tech Ref eq. 5.19, 5.20 (transmittance form, exp(-a s)); CFAST 7.7.7 source, radiation.f90 (absorb);
// SFPE Handbook of Fire Protection Engineering, 1988 ed., pp. 1-99 to 1-101 (emissivity data, see gasAbsorptionData.ts).
import {
  ABSORPTION_COEFFICIENT_FLOOR_PER_M,
  CO2_ABSORPTANCE_WEIGHT,
  GAS_ABSORPTANCE_MAX,
  GAS_ABSORPTION_M_CO2_KG_PER_MOL,
  GAS_ABSORPTION_M_H2O_KG_PER_MOL,
  MEAN_BEAM_LENGTH_FACTOR,
  R_ATM_M3_ATM_PER_MOL_K,
  SOOT_ABSORPTION_CONSTANT,
  SOOT_DENSITY_KG_PER_M3,
} from "../constants";
import {
  CO2_LOG10_EMISSIVITY,
  CO2_LOG10_T_K,
  H2O_LOG10_EMISSIVITY,
  H2O_LOG10_T_K,
  LOG10_PL_ATM_M,
} from "./gasAbsorptionData";

export interface LayerAbsorptionInput {
  tempK: number; // layer temperature
  volumeM3: number; // layer volume
  depthM: number; // layer depth
  floorAreaM2: number; // compartment floor area
  widthM: number; // compartment width
  roomDepthM: number; // compartment depth
  co2MassKg: number; // CO2 mass in the layer
  h2oMassKg: number; // H2O mass in the layer
  sootMassKg: number; // soot mass in the layer
}

// Index of the lower grid point of the cell that holds `v`, with `v` clamped into the axis range.
function locate(axis: readonly number[], v: number): { i: number; v: number } {
  const last = axis.length - 1;
  const first = axis[0] as number;
  const end = axis[last] as number;
  if (v <= first) return { i: 0, v: first };
  if (v >= end) return { i: last - 1, v: end };
  let i = 0;
  while (i < last - 1 && v >= (axis[i + 1] as number)) i++;
  return { i, v };
}

// CFAST 7.7.7 source, radiation.f90 (linterp): bilinear interpolation of a table z[j][i] on the axes (x, y),
// clamped at the table edges.
export function bilinearClamped(
  x: readonly number[],
  y: readonly number[],
  z: readonly (readonly number[])[],
  xv: number,
  yv: number,
): number {
  const a = locate(x, xv);
  const b = locate(y, yv);
  const x0 = x[a.i] as number;
  const x1 = x[a.i + 1] as number;
  const y0 = y[b.i] as number;
  const y1 = y[b.i + 1] as number;
  const z00 = (z[b.i] as readonly number[])[a.i] as number;
  const z10 = (z[b.i] as readonly number[])[a.i + 1] as number;
  const z01 = (z[b.i + 1] as readonly number[])[a.i] as number;
  const z11 = (z[b.i + 1] as readonly number[])[a.i + 1] as number;
  const tx = (a.v - x0) / (x1 - x0);
  const ty = (b.v - y0) / (y1 - y0);
  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty) + z01 * (1 - tx) * ty + z11 * tx * ty;
}

// CFAST 7.7.7 source, radiation.f90 (absorb): mean beam length L = 1.8 V / (A_floor + d (W + D)).
export function meanBeamLengthM(input: LayerAbsorptionInput): number {
  const wetted = input.floorAreaM2 + input.depthM * (input.widthM + input.roomDepthM);
  return wetted > 0 ? (MEAN_BEAM_LENGTH_FACTOR * input.volumeM3) / wetted : 0;
}

// CFAST 7.7.7 source, radiation.f90 (absorb): emissivity of one gas from its mass, from the ideal-gas partial
// pressure times path length pL = (m / M) R_atm T / V L (atm m) and the log-log table. Zero when pL is not positive.
function gasEmissivity(
  massKg: number,
  molarMassKgPerMol: number,
  input: LayerAbsorptionInput,
  lengthM: number,
  tAxis: readonly number[],
  table: readonly (readonly number[])[],
): number {
  const pl = ((massKg / molarMassKgPerMol) * R_ATM_M3_ATM_PER_MOL_K * input.tempK * lengthM) / input.volumeM3;
  if (!(pl > 0)) return 0;
  return 10 ** bilinearClamped(tAxis, LOG10_PL_ATM_M, table, Math.log10(input.tempK), Math.log10(pl));
}

// Tech Ref eq. 5.19, 5.20 form; CFAST 7.7.7 source, radiation.f90 (absorb): layer absorption coefficient, 1/m.
// Gas absorptance ag = 0.5 eCO2 + eH2O (SFPE Handbook, overlap correction neglected). Soot adds k fv T with
// fv = m_soot / (V rho_soot). Then a = max(k fv T - ln(1 - ag) / L, 0.01). The 0.01 1/m floor is CFAST's.
export function layerAbsorptionPerM(input: LayerAbsorptionInput): number {
  if (!(input.volumeM3 > 0) || !(input.tempK > 0)) return ABSORPTION_COEFFICIENT_FLOOR_PER_M;
  const length = meanBeamLengthM(input);
  if (!(length > 0)) return ABSORPTION_COEFFICIENT_FLOOR_PER_M;
  const eCo2 = gasEmissivity(input.co2MassKg, GAS_ABSORPTION_M_CO2_KG_PER_MOL, input, length, CO2_LOG10_T_K, CO2_LOG10_EMISSIVITY);
  const eH2o = gasEmissivity(input.h2oMassKg, GAS_ABSORPTION_M_H2O_KG_PER_MOL, input, length, H2O_LOG10_T_K, H2O_LOG10_EMISSIVITY);
  const ag = Math.min(CO2_ABSORPTANCE_WEIGHT * eCo2 + eH2o, GAS_ABSORPTANCE_MAX);
  const sootFraction = input.sootMassKg / (input.volumeM3 * SOOT_DENSITY_KG_PER_M3);
  const a = SOOT_ABSORPTION_CONSTANT * sootFraction * input.tempK - Math.log(1 - ag) / length;
  return Math.max(a, ABSORPTION_COEFFICIENT_FLOOR_PER_M);
}

// Tech Ref eq. 5.19, 5.20 form; CFAST 7.7.7 source, radiation.f90 (rdrtran, rdftran): transmittance exp(-a s)
// of a beam of length `beamM` in a layer with absorption coefficient `absorptionPerM`.
export function transmittance(absorptionPerM: number, beamM: number): number {
  return Math.exp(-absorptionPerM * beamM);
}
