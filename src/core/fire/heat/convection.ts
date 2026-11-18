// Convective heat transfer between a gas layer and a compartment surface.
// SI units. Positive flux is heat into the surface.
import {
  CEILING_JET_AREA_EXPONENT,
  CEILING_JET_FLUX_COEFFICIENT,
  CEILING_JET_HEIGHT_EXPONENT,
  CEILING_JET_MAX_RADIUS_OVER_HEIGHT,
  CONVECTION_C_HORIZONTAL,
  CONVECTION_C_WALL,
  CONVECTION_EXPONENT,
} from "../constants";

export type ConvectionSurfaceKind = "horizontal" | "wall";

// Tech Ref eq. 5.22, 5.23: C = 1.52 for ceiling and floor, 1.31 for walls.
export function convectionConstant(kind: ConvectionSurfaceKind): number {
  return kind === "horizontal" ? CONVECTION_C_HORIZONTAL : CONVECTION_C_WALL;
}

// Tech Ref eq. 5.22, 5.23: convective heat transfer coefficient h = C |Tg - Tw|^(1/3), W/(m2 K).
export function convectionCoeff(kind: ConvectionSurfaceKind, gasTempK: number, surfaceTempK: number): number {
  return convectionConstant(kind) * Math.abs(gasTempK - surfaceTempK) ** (CONVECTION_EXPONENT - 1);
}

// Tech Ref eq. 5.22, 5.23: convective flux into the surface, q'' = h (Tg - Tw) = C sign(dT) |dT|^(4/3), W/m2.
export function convectiveFlux(kind: ConvectionSurfaceKind, gasTempK: number, surfaceTempK: number): number {
  return convectionCoeff(kind, gasTempK, surfaceTempK) * (gasTempK - surfaceTempK);
}

export interface CeilingJetResult {
  fluxWPerM2: number; // average ceiling-jet flux, 0 when there is no convective heat release
  effectiveAreaM2: number; // area the flux acts on
}

// Tech Ref eq. 5.24 to 5.26 (early-fire ceiling heat transfer), CFAST 7.7.7 source, convection.f90, convection:
// average flux 0.27 Qc / (A_eff^0.68 H^0.64) with A_eff = min(pi (4 H)^2, W D) (valid for r/H < 4).
export function ceilingJetFlux(qConvectiveW: number, widthM: number, depthM: number, heightM: number): CeilingJetResult {
  const rMax = CEILING_JET_MAX_RADIUS_OVER_HEIGHT * heightM;
  const effectiveAreaM2 = Math.min(Math.PI * rMax * rMax, widthM * depthM);
  const fluxWPerM2 =
    (CEILING_JET_FLUX_COEFFICIENT * qConvectiveW) /
    (effectiveAreaM2 ** CEILING_JET_AREA_EXPONENT * heightM ** CEILING_JET_HEIGHT_EXPONENT);
  return { fluxWPerM2, effectiveAreaM2 };
}

export interface CeilingConvection {
  fluxWPerM2: number;
  areaM2: number; // area used in the layer energy term
}

// CFAST 7.7.7 source, convection.f90, convection (differs from the coefficient comparison of Tech Ref eq. 5.26):
// the ordinary ceiling flux is replaced by the ceiling-jet flux, and the ceiling area by A_eff, when the
// ceiling-jet flux is larger. qConvectiveW is the largest convective heat release rate of any fire in the room.
export function ceilingConvection(
  ordinaryFluxWPerM2: number,
  ceilingAreaM2: number,
  qConvectiveW: number,
  widthM: number,
  depthM: number,
  heightM: number,
): CeilingConvection {
  if (!(qConvectiveW > 0)) return { fluxWPerM2: ordinaryFluxWPerM2, areaM2: ceilingAreaM2 };
  const jet = ceilingJetFlux(qConvectiveW, widthM, depthM, heightM);
  if (jet.fluxWPerM2 > ordinaryFluxWPerM2) return { fluxWPerM2: jet.fluxWPerM2, areaM2: jet.effectiveAreaM2 };
  return { fluxWPerM2: ordinaryFluxWPerM2, areaM2: ceilingAreaM2 };
}
