// Visibility from soot (Tech Ref 6.2). Pure functions, SI units.
import { K_VIS, PERCENT_PER_FRACTION, SPECIFIC_EXTINCTION_COEFFICIENT_M2_PER_KG } from "../constants";

// Tech Ref eq. 6.3: Du = Km m'''_s / ln 10, optical density per metre (1/m). `sootKgPerM3` is the soot mass per unit
// volume of the layer, m'''_s = Y_soot * rho_layer. Zero soot gives exactly 0 (Requirement 8.6).
export function opticalDensityPerMetre(sootKgPerM3: number): number {
  if (!(sootKgPerM3 > 0)) return 0;
  return (SPECIFIC_EXTINCTION_COEFFICIENT_M2_PER_KG * sootKgPerM3) / Math.LN10;
}

// Tech Ref eq. 6.3 with the natural-log form: K = Km m'''_s = Du ln 10, extinction coefficient (1/m).
export function extinctionCoefficientPerMetre(sootKgPerM3: number): number {
  if (!(sootKgPerM3 > 0)) return 0;
  return SPECIFIC_EXTINCTION_COEFFICIENT_M2_PER_KG * sootKgPerM3;
}

// FDS User's Guide, VIS_C0 = 3 (light-reflecting signs): S = 3 / K, in m. Soot-free gas gives `Infinity`, the one
// documented representation of unbounded visibility in every Result (Requirement 8.6).
// Tech Ref eq. 6.3 (extinction coefficient K) with S = 3 / K from the FDS User's Guide.
export function visibilityM(sootKgPerM3: number): number {
  const k = extinctionCoefficientPerMetre(sootKgPerM3);
  return k > 0 ? K_VIS / k : Infinity;
}

// Tech Ref eq. 6.4: Ou = 100 (1 - 10^(-Du)), percent obscuration per metre.
export function percentObscurationPerMetre(opticalDensityPerM: number): number {
  if (!(opticalDensityPerM > 0)) return 0;
  return PERCENT_PER_FRACTION * (1 - Math.pow(10, -opticalDensityPerM));
}

export interface LayerSmoke {
  opticalDensityPerM: number;
  visibilityM: number;
}

// Optical density and visibility of one layer from its soot mass fraction and gas density (kg/m3).
// Tech Ref eq. 6.3 and 6.4: optical density and visibility of one layer from soot mass fraction times gas density.
export function layerSmoke(sootMassFraction: number, layerDensityKgPerM3: number): LayerSmoke {
  const sootKgPerM3 = sootMassFraction * layerDensityKgPerM3;
  return { opticalDensityPerM: opticalDensityPerMetre(sootKgPerM3), visibilityM: visibilityM(sootKgPerM3) };
}
