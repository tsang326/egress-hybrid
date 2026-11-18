// Two-layer gas state equations, right-hand sides only. Pure functions, SI units.
// Heat terms `q` already include the enthalpy carried by mass flows into the layer (Tech Ref App. B).
import { CP_J_PER_KG_K, GAMMA, GAS_R_J_PER_KG_K } from "../constants";

// Tech Ref eq. 2.4: ideal gas law, density of a gas at absolute pressure P and temperature T.
export function layerDensityKgPerM3(pressurePa: number, tempK: number): number {
  return pressurePa / (GAS_R_J_PER_KG_K * tempK);
}

// Tech Ref eq. 2.4: layer mass m = P V / (R T).
export function layerMassKg(pressurePa: number, volumeM3: number, tempK: number): number {
  return (pressurePa * volumeM3) / (GAS_R_J_PER_KG_K * tempK);
}

// Tech Ref eq. 2.5 (derived in B.7): dP/dt = (gamma - 1) / V * (ql + qu).
export function dPressureDt(compartmentVolumeM3: number, qLowerW: number, qUpperW: number): number {
  return ((GAMMA - 1) / compartmentVolumeM3) * (qLowerW + qUpperW);
}

// Tech Ref eq. 2.6 (derived in B.13): dVu/dt = 1 / (P gamma) * ((gamma - 1) qu - Vu dP/dt).
export function dUpperVolumeDt(
  pressurePa: number,
  upperVolumeM3: number,
  qUpperW: number,
  dPdtPaPerS: number,
): number {
  return ((GAMMA - 1) * qUpperW - upperVolumeM3 * dPdtPaPerS) / (pressurePa * GAMMA);
}

// Tech Ref eq. 2.7 (derived in B.19): dTu/dt = 1 / (cp mu) * (qu - cp mdot_u Tu + Vu dP/dt).
export function dUpperTempDt(
  upperMassKg: number,
  upperVolumeM3: number,
  upperTempK: number,
  qUpperW: number,
  netMassFlowUpperKgPerS: number,
  dPdtPaPerS: number,
): number {
  return (
    (qUpperW - CP_J_PER_KG_K * netMassFlowUpperKgPerS * upperTempK + upperVolumeM3 * dPdtPaPerS) /
    (CP_J_PER_KG_K * upperMassKg)
  );
}

// Tech Ref eq. 2.8 (derived in B.20): dTl/dt = 1 / (cp ml) * (ql - cp mdot_l Tl + Vl dP/dt).
export function dLowerTempDt(
  lowerMassKg: number,
  lowerVolumeM3: number,
  lowerTempK: number,
  qLowerW: number,
  netMassFlowLowerKgPerS: number,
  dPdtPaPerS: number,
): number {
  return (
    (qLowerW - CP_J_PER_KG_K * netMassFlowLowerKgPerS * lowerTempK + lowerVolumeM3 * dPdtPaPerS) /
    (CP_J_PER_KG_K * lowerMassKg)
  );
}

export interface LayerSourceTerms {
  qUpperW: number; // heat into the upper layer including enthalpy of inflow, W
  qLowerW: number;
  mdotUpperKgPerS: number; // net mass flow into the upper layer, kg/s
  mdotLowerKgPerS: number;
}

export interface LayerState {
  pressurePa: number; // absolute pressure
  upperVolumeM3: number; // already clamped to [VMIN, VMAX]
  upperTempK: number;
  lowerTempK: number;
}

// Tech Ref eq. 2.5 to 2.8: all four derivatives of one compartment, written into `out` as
// [dP/dt, dVu/dt, dTu/dt, dTl/dt]. `lowerVolumeM3` is V - Vu clamped to [VMIN, VMAX].
export function layerDerivatives(
  compartmentVolumeM3: number,
  lowerVolumeM3: number,
  state: LayerState,
  sources: LayerSourceTerms,
  out: Float64Array,
): void {
  const { pressurePa, upperVolumeM3, upperTempK, lowerTempK } = state;
  const dP = dPressureDt(compartmentVolumeM3, sources.qLowerW, sources.qUpperW);
  const mu = layerMassKg(pressurePa, upperVolumeM3, upperTempK);
  const ml = layerMassKg(pressurePa, lowerVolumeM3, lowerTempK);
  out[0] = dP;
  out[1] = dUpperVolumeDt(pressurePa, upperVolumeM3, sources.qUpperW, dP);
  out[2] = dUpperTempDt(mu, upperVolumeM3, upperTempK, sources.qUpperW, sources.mdotUpperKgPerS, dP);
  out[3] = dLowerTempDt(ml, lowerVolumeM3, lowerTempK, sources.qLowerW, sources.mdotLowerKgPerS, dP);
}

// Requirement 3.4 (Tech Ref Fig. 2.1): interface height = H - Vu / (W D), clamped to [0, H] (Requirement 3.6).
// A non-finite input gives NaN so that the driver can detect it.
export function interfaceHeightM(heightM: number, upperVolumeM3: number, floorAreaM2: number): number {
  const z = heightM - upperVolumeM3 / floorAreaM2;
  if (Number.isNaN(z)) return NaN;
  return Math.min(Math.max(z, 0), heightM);
}
