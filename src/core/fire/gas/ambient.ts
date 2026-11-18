// Ambient air density and the hydrostatic ambient pressure profile. Pure functions, SI units.
import {
  AMBIENT_PRESSURE_REFERENCE_ELEVATION_M,
  GAS_R_J_PER_KG_K,
  GRAVITY_M_PER_S2,
} from "../constants";

// Tech Ref eq. 2.4: ambient air density rho = P / (R T).
export function ambientDensityKgPerM3(pressurePa: number, tempK: number): number {
  return pressurePa / (GAS_R_J_PER_KG_K * tempK);
}

// Requirement 2.5, Tech Ref eq. 2.4 with CFAST 7.7.7 source, prec.f90 (g): absolute ambient pressure at
// elevation z, P(z) = P0 - rho0 g (z - z0), with rho0 = P0 / (R T) at the exterior temperature.
// One profile serves every compartment and the Outside, so the difference between two floors is rho0 g (z2 - z1) (up to the sign).
export function ambientPressureAtPa(
  elevationM: number,
  pressureAtReferencePa: number,
  exteriorTempK: number,
): number {
  const rho0 = ambientDensityKgPerM3(pressureAtReferencePa, exteriorTempK);
  return pressureAtReferencePa - rho0 * GRAVITY_M_PER_S2 * (elevationM - AMBIENT_PRESSURE_REFERENCE_ELEVATION_M);
}
