// Ceiling and floor vent flow: pressure-driven flow, buoyant exchange flow, layer extraction with plug-holing, and
// deposition into the upper compartment. Pure functions, SI units.
//
// Tech Ref section 4.2 (eq. 4.8 to 4.14), with the details of CFAST 7.7.7 source, flowvertical.f90 (vertical_flow, ventcf).
//
// End numbering of every result: end 0 is the upper compartment (CFAST itop), end 1 is the lower compartment (CFAST ibot).
import {
  CEILING_VENT_FLOW_COEFFICIENT,
  DELTATEMP_MIN_K,
  EXCHANGE_FLOW_COEFFICIENT,
  EXCHANGE_SHAPE_COEFFICIENT_ROUND,
  EXCHANGE_SHAPE_COEFFICIENT_SQUARE,
  EXTRACTION_FADE_HIGH_VMIN,
  EXTRACTION_FADE_LOW_VMIN,
  GRAVITY_M_PER_S2,
  PLUG_HOLING_FROUDE_DIVISOR,
  VENT_DAMPING_CUTOFF_RATIO,
  VENT_PRESSURE_EPS,
  VENT_THIN_LAYER_VMIN,
} from "../constants";
import { tanhSmooth } from "../gas/layerMixing";
import type { MassTransfer, VentFlowResult, VentLayer, VerticalVentEndState } from "./ventTypes";

export interface CeilingFloorVentGeometry {
  areaM2: number; // full area, before the open fraction
  shape: "round" | "square";
  openFraction: number;
}

export interface CeilingFloorVentOptions {
  interiorAmbientTempK: number; // reference temperature of the Froude number
  pressureEps?: number; // default VENT_PRESSURE_EPS
}

export interface CeilingFloorVolumeFlows {
  delpPa: number; // pressure below the vent minus pressure above it
  upVolumeM3PerS: number; // from the lower to the upper compartment
  downVolumeM3PerS: number; // from the upper to the lower compartment
  upMassKgPerS: number;
  downMassKgPerS: number;
  upSourceLayer: VentLayer; // layer of the lower compartment that feeds the upward flow
  downSourceLayer: VentLayer; // layer of the upper compartment that feeds the downward flow
}

// Tech Ref eq. 4.10: pressure difference at which the exchange flow stops, Pa. Cs is 0.754 (round) or 0.942 (square);
// D is the diameter (round) or the side (square); drho is the density difference (lighter below is not unstable).
export function floodPressurePa(areaM2: number, shape: "round" | "square", deltaDensityKgPerM3: number): number {
  const cs = shape === "round" ? EXCHANGE_SHAPE_COEFFICIENT_ROUND : EXCHANGE_SHAPE_COEFFICIENT_SQUARE;
  const d = shape === "round" ? 2 * Math.sqrt(areaM2 / Math.PI) : Math.sqrt(areaM2);
  return (cs * cs * GRAVITY_M_PER_S2 * deltaDensityKgPerM3 * Math.pow(d, 5)) / (2 * areaM2 * areaM2);
}

// Tech Ref eq. 4.8, 4.9, 4.10, CFAST 7.7.7 source, flowvertical.f90 (ventcf): volume and mass flows through the vent.
// Flow follows the sign of the pressure difference (eq. 4.8, 4.9, coefficient 0.68). When the denser gas is above
// (delta rho > 0) an exchange flow is added in both directions (eq. 4.10), which fades out at the flooding pressure.
export function ceilingFloorVolumeFlows(
  areaM2: number,
  shape: "round" | "square",
  top: VerticalVentEndState,
  bottom: VerticalVentEndState,
  pressureEps: number = VENT_PRESSURE_EPS,
): CeilingFloorVolumeFlows {
  const g = GRAVITY_M_PER_S2;
  // Pressure just below the vent (in the bottom compartment, at its ceiling) and just above it (top compartment, at its floor).
  const botDepthL = bottom.interfaceHeightM;
  const botDepthU = bottom.heightM - bottom.interfaceHeightM;
  const dpBelow = bottom.isOutside ? 0 : -g * (bottom.lowerDensityKgPerM3 * botDepthL + bottom.upperDensityKgPerM3 * botDepthU);
  const dpAbove = top.isOutside ? -g * top.heightM * top.lowerDensityKgPerM3 : 0;
  const relpBelow = bottom.floorPressurePa;
  const relpAbove = top.floorPressurePa;
  const delp = relpBelow + dpBelow - (relpAbove + dpAbove);

  // Layer adjacent to the vent. A layer thinner than 2 VMIN counts as absent.
  const topLayer: VentLayer = top.lowerVolumeM3 <= VENT_THIN_LAYER_VMIN * top.minVolumeM3 ? "upper" : "lower";
  const botLayer: VentLayer = bottom.upperVolumeM3 <= VENT_THIN_LAYER_VMIN * bottom.minVolumeM3 ? "lower" : "upper";

  const denAbove = top.isOutside
    ? (top.ambientDensityAtCeilingKgPerM3 ?? top.lowerDensityKgPerM3)
    : topLayer === "upper"
      ? top.upperDensityKgPerM3
      : top.lowerDensityKgPerM3;
  const denBelow = bottom.isOutside
    ? bottom.lowerDensityKgPerM3
    : botLayer === "upper"
      ? bottom.upperDensityKgPerM3
      : bottom.lowerDensityKgPerM3;
  const delden = denAbove - denBelow;
  const rho = delp >= 0 ? denBelow : denAbove;

  // Damp very small flows to zero (CFAST fnoise).
  const epscut = Math.sqrt(pressureEps * Math.max(1, relpAbove, relpBelow));
  const srdelp = Math.sqrt(Math.abs(delp));
  let fnoise = 1;
  if (srdelp / epscut <= VENT_DAMPING_CUTOFF_RATIO) fnoise = 1 - Math.exp(-srdelp / epscut);

  // Tech Ref eq. 4.8, 4.9: steady flow.
  const v = CEILING_VENT_FLOW_COEFFICIENT * areaM2 * Math.sqrt((2 * Math.abs(delp)) / rho) * fnoise;
  const vUp = delp > 0 ? v : 0;
  const vDown = delp < 0 ? v : 0;

  // Tech Ref eq. 4.10: exchange flow.
  let vex = 0;
  if (delden > 0 && areaM2 !== 0) {
    const dpFlood = floodPressurePa(areaM2, shape, delden);
    vex = Math.max(
      EXCHANGE_FLOW_COEFFICIENT *
        Math.sqrt(((2 * g * delden * Math.sqrt(Math.pow(areaM2, 5))) / (denAbove + denBelow))) *
        (1 - Math.abs(delp / dpFlood)),
      0,
    );
  }
  const upVol = vUp + vex;
  const downVol = vDown + vex;
  return {
    delpPa: delp,
    upVolumeM3PerS: upVol,
    downVolumeM3PerS: downVol,
    upMassKgPerS: denBelow * upVol,
    downMassKgPerS: denAbove * downVol,
    upSourceLayer: botLayer,
    downSourceLayer: topLayer,
  };
}

// Tech Ref eq. 4.11 to 4.14, CFAST 7.7.7 source, flowvertical.f90 (vertical_flow): Froude number of the flow leaving a layer.
// Fr = Q / sqrt(g z^5 (T - T0) / T0), z the depth of the layer that feeds the flow. Zero when the gas is not hotter than ambient.
export function extractionFroude(
  volumeFlowM3PerS: number,
  layerDepthM: number,
  flowTempK: number,
  interiorAmbientTempK: number,
): number {
  if (!(flowTempK > interiorAmbientTempK)) return 0;
  const denom = Math.sqrt((GRAVITY_M_PER_S2 * Math.pow(layerDepthM, 5) * (flowTempK - interiorAmbientTempK)) / interiorAmbientTempK);
  if (denom === 0) return volumeFlowM3PerS > 0 ? Infinity : 0;
  return volumeFlowM3PerS / denom;
}

// Tech Ref eq. 4.13, 4.14: plug-holing weight alpha = exp(-(Fr / 2)^2), the share of the flow that comes from the nominal layer.
export function plugHoleWeight(froude: number): number {
  const r = froude / PLUG_HOLING_FROUDE_DIVISOR;
  return Math.exp(-(r * r));
}

// CFAST 7.7.7 source, flowvertical.f90 (vertical_flow): shares (fromUpper, fromLower) of an extraction whose nominal layer is `nominal`.
// A layer that is nearly absent (volume between 2 and 3 VMIN) is faded out so the vent never takes from a layer that is not there.
function extractionShares(
  nominal: VentLayer,
  alpha: number,
  upperVolumeM3: number,
  lowerVolumeM3: number,
  vminM3: number,
): { fromUpper: number; fromLower: number } {
  const hi = EXTRACTION_FADE_HIGH_VMIN * vminM3;
  const lo = EXTRACTION_FADE_LOW_VMIN * vminM3;
  if (nominal === "upper") {
    let fu = Math.min(tanhSmooth(upperVolumeM3, hi, lo, alpha, 0), 1);
    fu = Math.min(tanhSmooth(lowerVolumeM3, hi, lo, fu, 1), 1);
    return { fromUpper: fu, fromLower: Math.max(1 - fu, 0) };
  }
  let fl = Math.min(tanhSmooth(lowerVolumeM3, hi, lo, alpha, 0), 1);
  fl = Math.min(tanhSmooth(upperVolumeM3, hi, lo, fl, 1), 1);
  return { fromUpper: Math.max(1 - fl, 0), fromLower: fl };
}

// Requirements 5.1, 5.5, Tech Ref eq. 4.8 to 4.14 and the end of section 4.2, CFAST 7.7.7 source, flowvertical.f90 (vertical_flow):
// all flows through one ceiling or floor vent at one instant. `top` is the upper compartment (end 0), `bottom` the lower (end 1).
// The upward flow leaves the bottom compartment's upper layer, the downward flow leaves the top compartment's lower layer
// (each with plug-holing and thin-layer fading). The gas is deposited into the destination upper layer when it is hotter
// than the destination lower layer by more than 1 K, otherwise into the lower layer.
// A vent to the Outside uses the ambient state as the missing end; transfers that touch it are for the caller to ignore.
// Mass is conserved by construction: each transfer removes and adds the same mass.
export function ceilingFloorVentFlows(
  vent: CeilingFloorVentGeometry,
  top: VerticalVentEndState,
  bottom: VerticalVentEndState,
  options: CeilingFloorVentOptions,
): VentFlowResult {
  const area = vent.openFraction * vent.areaM2;
  if (!(area > 0)) return { transfers: [], openFraction: vent.openFraction, areaM2: 0 };
  const flows = ceilingFloorVolumeFlows(area, vent.shape, top, bottom, options.pressureEps ?? VENT_PRESSURE_EPS);
  const transfers: MassTransfer[] = [];

  // iflow 1: upward, bottom -> top, nominal source layer upper. iflow 2: downward, top -> bottom, nominal source layer lower.
  const legs = [
    { from: bottom, fromIdx: 1 as const, to: top, toIdx: 0 as const, nominal: "upper" as VentLayer, mass: flows.upMassKgPerS, vol: flows.upVolumeM3PerS, tempLayer: flows.upSourceLayer },
    { from: top, fromIdx: 0 as const, to: bottom, toIdx: 1 as const, nominal: "lower" as VentLayer, mass: flows.downMassKgPerS, vol: flows.downVolumeM3PerS, tempLayer: flows.downSourceLayer },
  ];
  for (const leg of legs) {
    if (!(leg.mass > 0)) continue;
    const { from, to } = leg;
    let fromUpper: number;
    let fromLower: number;
    if (from.isOutside) {
      fromUpper = 0;
      fromLower = 1;
    } else {
      const flowTemp = leg.tempLayer === "upper" ? from.upperTempK : from.lowerTempK;
      const depth = leg.nominal === "upper" ? from.heightM - from.interfaceHeightM : from.interfaceHeightM;
      const fr = extractionFroude(leg.vol, depth, flowTemp, options.interiorAmbientTempK);
      const alpha = plugHoleWeight(fr);
      const s = extractionShares(leg.nominal, alpha, from.upperVolumeM3, from.lowerVolumeM3, from.minVolumeM3);
      fromUpper = s.fromUpper;
      fromLower = s.fromLower;
    }
    const fromTempK = fromUpper * from.upperTempK + fromLower * from.lowerTempK;
    const toLayer: VentLayer = fromTempK > to.lowerTempK + DELTATEMP_MIN_K ? "upper" : "lower";
    if (fromUpper > 0) {
      transfers.push({ kind: "flow", fromEnd: leg.fromIdx, fromLayer: "upper", toEnd: leg.toIdx, toLayer, massKgS: fromUpper * leg.mass, sourceTempK: from.upperTempK });
    }
    if (fromLower > 0) {
      transfers.push({ kind: "flow", fromEnd: leg.fromIdx, fromLayer: "lower", toEnd: leg.toIdx, toLayer, massKgS: fromLower * leg.mass, sourceTempK: from.lowerTempK });
    }
  }
  return { transfers, openFraction: vent.openFraction, areaM2: area };
}
