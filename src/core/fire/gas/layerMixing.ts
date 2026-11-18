// Lower-to-upper layer mixing. Not in the Tech Ref; follows CFAST 7.7.7 (on by default there).
import {
  CP_J_PER_KG_K,
  LAYER_MIXING_COEFFICIENT_W_PER_M2_K2,
  LAYER_MIXING_MASS_FACTOR_MAX,
  TANH_SMOOTH_OFFSET,
  TANH_SMOOTH_SCALE,
  TANH_SMOOTH_SHIFT,
  TANH_SMOOTH_SPAN,
} from "../constants";

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth): smooth step from `yMin` at x <= xMin to `yMax` at x >= xMax.
export function tanhSmooth(x: number, xMax: number, xMin: number, yMax: number, yMin: number): number {
  const span = xMax - xMin;
  if (!(span > 0)) return x >= xMax ? yMax : yMin;
  const arg = (TANH_SMOOTH_SPAN / span) * (x - xMin) - TANH_SMOOTH_SHIFT;
  const f = Math.min(Math.max(TANH_SMOOTH_OFFSET + TANH_SMOOTH_SCALE * Math.tanh(arg), 0), 1);
  return f * (yMax - yMin) + yMin;
}

export interface LayerMixingInput {
  upperTempK: number;
  lowerTempK: number;
  ceilingAreaM2: number; // CFAST wall_area4(1), the floor area of the compartment
  lowerMassKg: number;
  lowerDensityKgPerM3: number;
  minLayerVolumeM3: number;
  lowerSpeciesMassKg: ArrayLike<number>; // mass of each tracked species in the lower layer
}

export interface LayerMixingFlows {
  energyUpperW: number; // energy moved into the upper layer; the lower layer gets the negative
  massUpperKgPerS: number; // mass moved into the upper layer; the lower layer gets the negative
  speciesUpperKgPerS: Float64Array; // species mass moved into the upper layer, same order as the input
}

// CFAST 7.7.7 source, compartments.f90 (layer_mixing): when Tl > Tu, q = 1000 (Tl - Tu)^2 A moves up, with
// mass q fm / (cp Tl) and fm = tanhsmooth(ml, 2 vmin rho_l, vmin rho_l, 0.5, 0). Species move in proportion
// to the lower-layer composition. Everything is zero when Tl <= Tu. If the lower layer holds no species mass,
// the mass flow is zero and only the energy moves, as in CFAST.
export function layerMixing(input: LayerMixingInput): LayerMixingFlows {
  const n = input.lowerSpeciesMassKg.length;
  const species = new Float64Array(n);
  const zero: LayerMixingFlows = { energyUpperW: 0, massUpperKgPerS: 0, speciesUpperKgPerS: species };
  if (!(input.lowerTempK > input.upperTempK)) return zero;

  const dT = input.lowerTempK - input.upperTempK;
  const energy = LAYER_MIXING_COEFFICIENT_W_PER_M2_K2 * dT * dT * input.ceilingAreaM2;
  const vminMass = input.minLayerVolumeM3 * input.lowerDensityKgPerM3;
  const fm = tanhSmooth(input.lowerMassKg, 2 * vminMass, vminMass, LAYER_MIXING_MASS_FACTOR_MAX, 0);
  const mass = (fm * energy) / (CP_J_PER_KG_K * input.lowerTempK);

  let speciesTotal = 0;
  for (let i = 0; i < n; i++) speciesTotal += input.lowerSpeciesMassKg[i] as number;
  if (!(speciesTotal > 0)) return { energyUpperW: energy, massUpperKgPerS: 0, speciesUpperKgPerS: species };

  for (let i = 0; i < n; i++) species[i] = ((input.lowerSpeciesMassKg[i] as number) / speciesTotal) * mass;
  return { energyUpperW: energy, massUpperKgPerS: mass, speciesUpperKgPerS: species };
}
