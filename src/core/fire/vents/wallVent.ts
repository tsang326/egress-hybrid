// Wall vent flow: Bernoulli flow through a vertical vent split into slabs at the layer interfaces and the neutral plane,
// routing of each slab to a layer, and the spill plume (door jet) entrainment. Pure functions, SI units.
//
// Tech Ref chapter 4, section 4.1 (eq. 4.1 to 4.7), with the slab construction of CFAST 7.7.7 source,
// flowhorizontal.f90 (ventw, get_slab_elevations, delp, flogo, spill_plume, poreh_plume).
import {
  CP_J_PER_KG_K,
  DELTATEMP_MIN_K,
  GRAVITY_M_PER_S2,
  SPILL_PLUME_DENSITY_NUMERATOR_KG_K_PER_M3,
  SPILL_PLUME_ENTRAINMENT_COEFFICIENT,
  SPILL_PLUME_LOWER_LAYER_FACTOR,
  VENT_DAMPING_CUTOFF_RATIO,
  VENT_DELP_CUT_FACTOR,
  VENT_MIN_AREA_M2,
  VENT_PRESSURE_EPS,
  WALL_VENT_FLOW_COEFFICIENT,
} from "../constants";
import { tanhSmooth } from "../gas/layerMixing";
import type { MassTransfer, VentEndState, VentFlowResult, VentLayer } from "./ventTypes";

export interface WallVentGeometry {
  sillM: number; // above the floor of the first end
  soffitM: number; // above the floor of the first end
  widthM: number; // full width, before the open fraction
  openFraction: number; // 0 to 1
}

export interface WallVentOptions {
  // Eq. 4.6, 4.7. false for leakage vents (CFAST 7.7.7 source, flowhorizontal.f90, leakage_flow).
  spillPlume?: boolean;
  flowCoefficient?: number; // default WALL_VENT_FLOW_COEFFICIENT
  pressureEps?: number; // default VENT_PRESSURE_EPS
}

// Tech Ref eq. 4.5, CFAST 7.7.7 source, flowhorizontal.f90 (ventw): mass flow through one slab, kg/s, with pressure
// differences p1 and p2 (Pa, absolute values) at the bottom and top of the slab. Equal to the integral of eq. 4.1 with
// C = 0.7, written so that it does not divide by |dPt| - |dPb| (eq. 4.3 is the unsafe form).
export function wallVentSegmentFlowKgPerS(
  densityKgPerM3: number,
  areaM2: number,
  pBottomPa: number,
  pTopPa: number,
  flowCoefficient: number = WALL_VENT_FLOW_COEFFICIENT,
): number {
  const p1 = Math.abs(pBottomPa);
  const p2 = Math.abs(pTopPa);
  if (!(p1 > 0 || p2 > 0)) return 0;
  const p1rt = Math.sqrt(p1);
  const p2rt = Math.sqrt(p2);
  const r1 = Math.max(densityKgPerM3, 0);
  return (flowCoefficient * Math.sqrt(8 * r1) * areaM2 * ((p2 + p1rt * p2rt + p1) / (p2rt + p1rt))) / 3;
}

// CFAST 7.7.7 source, flowhorizontal.f90 (get_slab_elevations): absolute elevations that bound the slabs before neutral planes
// are added: vent bottom, vent top, and each layer interface that lies strictly inside the vent.
export function slabElevationsM(yvBotM: number, yvTopM: number, zlay1M: number, zlay2M: number): number[] {
  const ymin = Math.min(zlay1M, zlay2M);
  const ymax = Math.max(zlay1M, zlay2M);
  if (ymax >= yvTopM && (ymin >= yvTopM || ymin <= yvBotM)) return [yvBotM, yvTopM];
  if (ymax <= yvBotM) return [yvBotM, yvTopM];
  if (ymax >= yvTopM && ymin > yvBotM) return [yvBotM, ymin, yvTopM];
  if (ymin <= yvBotM && ymax < yvTopM) return [yvBotM, ymax, yvTopM];
  return [yvBotM, ymin, ymax, yvTopM];
}

interface EndGeometry {
  zflor: number; // absolute floor elevation
  zlay: number; // absolute interface elevation
  pflor: number;
  denl: number;
  denu: number;
}

function endGeometry(end: VentEndState): EndGeometry {
  return {
    zflor: end.floorElevationM,
    zlay: end.interfaceHeightM + end.floorElevationM,
    pflor: end.floorPressurePa,
    denl: end.lowerDensityKgPerM3,
    denu: end.upperDensityKgPerM3,
  };
}

// Pressure of one end at absolute elevation y, relative to the common reference (hydrostatic, piecewise linear).
function endPressureAt(e: EndGeometry, y: number): number {
  const gDenL = -e.denl * GRAVITY_M_PER_S2;
  const gDenU = -e.denu * GRAVITY_M_PER_S2;
  if (e.zflor <= y && y <= e.zlay) return e.pflor + (y - e.zflor) * gDenL;
  if (y > e.zlay) return e.pflor + -(e.zlay - e.zflor) * e.denl * GRAVITY_M_PER_S2 + gDenU * (y - e.zlay);
  return e.pflor;
}

// CFAST 7.7.7 source, flowhorizontal.f90 (delp): pressure of end 1 minus end 2 at elevation y, with very small
// differences damped to zero so the integrator does not see noise.
function pressureDifferencePa(e1: EndGeometry, e2: EndGeometry, y: number, eps: number): number {
  const dp1 = endPressureAt(e1, y);
  const dp2 = endPressureAt(e2, y);
  const epscut = VENT_DELP_CUT_FACTOR * eps * Math.max(1, Math.abs(dp1), Math.abs(dp2));
  const dpold = dp1 - dp2;
  if (Math.abs(dpold / epscut) <= VENT_DAMPING_CUTOFF_RATIO) {
    return (1 - Math.exp(-Math.abs(dpold / epscut))) * dpold;
  }
  return dpold;
}

interface Slab {
  yMidM: number;
  dir: 1 | -1 | 0; // 1: end 1 to end 2
  massKgS: number;
  tempK: number;
}

// Tech Ref section 4.1.1, CFAST 7.7.7 source, flowhorizontal.f90 (ventw): slabs between the elevations in `slabElevationsM`,
// further split at each neutral plane, with the flow of each slab from eq. 4.5.
function buildSlabs(
  e1: EndGeometry,
  e2: EndGeometry,
  end1: VentEndState,
  end2: VentEndState,
  yvBot: number,
  yvTop: number,
  areaM2: number,
  cvent: number,
  eps: number,
): Slab[] {
  const yelev = slabElevationsM(yvBot, yvTop, e1.zlay, e2.zlay);
  const dp = yelev.map((y) => pressureDifferencePa(e1, e2, y, eps));
  const yv: number[] = [];
  const dpv: number[] = [];
  const n = yelev.length;
  for (let i = 0; i < n - 1; i++) {
    yv.push(yelev[i] as number);
    dpv.push(dp[i] as number);
    const a = dp[i] as number;
    const b = dp[i + 1] as number;
    if (a * b < 0) {
      // Tech Ref section 4.1.1: a neutral plane lies between two elevations of opposite sign (linear interpolation).
      const ya = yelev[i] as number;
      const yb = yelev[i + 1] as number;
      let yn = (yb * a - ya * b) / (a - b);
      if (yn < ya || yn > yb) yn = (ya + yb) / 2; // CFAST fail-safe
      yv.push(yn);
      dpv.push(0);
    }
  }
  yv.push(yelev[n - 1] as number);
  dpv.push(dp[n - 1] as number);

  const ends = [end1, end2] as const;
  const geoms = [e1, e2] as const;
  const slabs: Slab[] = [];
  for (let i = 0; i < yv.length - 1; i++) {
    const yBot = yv[i] as number;
    const yTopSlab = yv[i + 1] as number;
    const dpB = dpv[i] as number;
    const dpT = dpv[i + 1] as number;
    const ptest = dpT + dpB;
    const dir: 1 | -1 | 0 = ptest > 0 ? 1 : ptest < 0 ? -1 : 0;
    const j = dir === -1 ? 1 : 0; // end the gas comes from
    const yMid = (yBot + yTopSlab) / 2;
    const upwindEnd = ends[j] as VentEndState;
    const upwindGeom = geoms[j] as EndGeometry;
    const lowerLayer = yMid <= upwindGeom.zlay;
    const tempK = lowerLayer ? upwindEnd.lowerTempK : upwindEnd.upperTempK;
    const density = lowerLayer ? upwindEnd.lowerDensityKgPerM3 : upwindEnd.upperDensityKgPerM3;
    let massKgS = 0;
    if (Math.abs(dpB) > 0 || Math.abs(dpT) > 0) {
      const area = (areaM2 * (yTopSlab - yBot)) / (yvTop - yvBot);
      massKgS = wallVentSegmentFlowKgPerS(density, area, dpB, dpT, cvent);
    }
    slabs.push({ yMidM: yMid, dir, massKgS, tempK });
  }
  return slabs;
}

// CFAST 7.7.7 source, flowhorizontal.f90 (flogo): take each slab out of the layer of the source end that holds it, and
// put it into the destination upper or lower layer by a smooth switch on the slab temperature.
function routeSlabs(slabs: readonly Slab[], ends: readonly [VentEndState, VentEndState], zlay: readonly [number, number]): MassTransfer[] {
  const out: MassTransfer[] = [];
  for (const s of slabs) {
    if (s.dir === 0 || !(s.massKgS > 0)) continue;
    const from: 0 | 1 = s.dir === 1 ? 0 : 1;
    const to: 0 | 1 = s.dir === 1 ? 1 : 0;
    const toEnd = ends[to];
    const tUpper = toEnd.upperTempK;
    const tLower = Math.min(toEnd.lowerTempK, tUpper);
    // Smooth from all-lower to all-upper over the range (Tl - dT) to (Tu + dT).
    const fUpper = tanhSmooth(s.tempK, tUpper + DELTATEMP_MIN_K, tLower - DELTATEMP_MIN_K, 1, 0);
    const fLower = 1 - fUpper;
    const fromLayer: VentLayer = s.yMidM >= zlay[from] ? "upper" : "lower";
    if (fUpper > 0) {
      out.push({ kind: "flow", fromEnd: from, fromLayer, toEnd: to, toLayer: "upper", massKgS: fUpper * s.massKgS, sourceTempK: s.tempK });
    }
    if (fLower > 0) {
      out.push({ kind: "flow", fromEnd: from, fromLayer, toEnd: to, toLayer: "lower", massKgS: fLower * s.massKgS, sourceTempK: s.tempK });
    }
  }
  return out;
}

// Tech Ref eq. 4.6 and 4.7, CFAST 7.7.7 source, flowhorizontal.f90 (poreh_plume): mass entrained into a spill plume, kg/s.
// Heat flow hdot = cp (Tu - Tl) mdot (eq. 4.6). Entrainment = Cm (Tl/Tu)^(2/3) (g rho_l^2 / (cp Tl))^(1/3) hdot^(1/3) w^(2/3) z (eq. 4.7).
export function spillPlumeEntrainmentKgPerS(
  upperTempK: number,
  lowerTempK: number,
  massFlowKgPerS: number,
  heightM: number,
  widthM: number,
): number {
  const hdot = CP_J_PER_KG_K * (upperTempK - lowerTempK) * massFlowKgPerS; // Tech Ref eq. 4.6
  const rhoL = SPILL_PLUME_DENSITY_NUMERATOR_KG_K_PER_M3 / lowerTempK;
  return (
    SPILL_PLUME_ENTRAINMENT_COEFFICIENT * // Tech Ref eq. 4.7
    Math.pow(lowerTempK / upperTempK, 2 / 3) *
    Math.cbrt((GRAVITY_M_PER_S2 * rhoL * rhoL) / (CP_J_PER_KG_K * lowerTempK)) *
    Math.cbrt(hdot) *
    Math.pow(widthM, 2 / 3) *
    heightM
  );
}

// Tech Ref section 4.1.1 (eq. 4.6, 4.7), CFAST 7.7.7 source, flowhorizontal.f90 (spill_plume): entrainment of the destination's
// gas into a slab that crosses a layer interface. Returns transfers inside the destination end:
//   hot gas that enters the upper layer (slab above the source interface) pulls lower-layer gas up into the upper layer;
//   cold gas that enters the lower layer pulls upper-layer gas down, reduced by a factor of 0.25.
function spillPlumeTransfers(
  slabs: readonly Slab[],
  ends: readonly [VentEndState, VentEndState],
  zlay: readonly [number, number],
  yvBot: number,
  yvTop: number,
  widthM: number,
): MassTransfer[] {
  const out: MassTransfer[] = [];
  for (const s of slabs) {
    const y = s.yMidM;
    // Entrainment needs the slab to lie above one interface and below the other.
    if (!(y < zlay[0] || y < zlay[1])) continue;
    if (!(y >= zlay[0] || y >= zlay[1])) continue;
    if (s.massKgS === 0 || s.dir === 0) continue;
    const ifrom: 0 | 1 = s.dir === 1 ? 0 : 1;
    const ito: 0 | 1 = s.dir === 1 ? 1 : 0;
    const from = ends[ifrom];
    const to = ends[ito];
    if (y >= zlay[ifrom]) {
      // Into the upper layer of the destination.
      if (from.upperTempK > to.lowerTempK) {
        const zd = Math.max(0, zlay[ito] - Math.max(yvBot, zlay[ifrom]));
        const m = spillPlumeEntrainmentKgPerS(from.upperTempK, to.lowerTempK, s.massKgS, zd, widthM);
        if (m > 0) out.push({ kind: "entrainment", fromEnd: ito, fromLayer: "lower", toEnd: ito, toLayer: "upper", massKgS: m, sourceTempK: to.lowerTempK });
      }
    } else if (from.lowerTempK < to.upperTempK) {
      // Into the lower layer of the destination.
      // CFAST computes zd = min(yvtop, zlay(ifrom)) - max(zlay(ito), yvbot); a negative height would give negative entrainment, so it is floored at 0.
      const zd = Math.max(0, Math.min(yvTop, zlay[ifrom]) - Math.max(zlay[ito], yvBot));
      const m =
        SPILL_PLUME_LOWER_LAYER_FACTOR *
        spillPlumeEntrainmentKgPerS(to.upperTempK, from.lowerTempK, s.massKgS, zd, widthM);
      if (m > 0) out.push({ kind: "entrainment", fromEnd: ito, fromLayer: "upper", toEnd: ito, toLayer: "lower", massKgS: m, sourceTempK: to.upperTempK });
    }
  }
  return out;
}

// Requirements 4.1, 4.2, 4.5, 4.8, Tech Ref eq. 4.1 to 4.7, CFAST 7.7.7 source, flowhorizontal.f90 (wall_flow, ventw, flogo):
// all flows through one wall vent between end1 and end2 at one instant.
// Closed vent: when height x width x f < 1e-10 m2 the result has no transfers, so every flow is exactly 0 (Requirement 4.5).
// Mass is conserved by construction (Requirement 4.8): each flow transfer removes and adds the same mass.
export function wallVentFlows(
  vent: WallVentGeometry,
  end1: VentEndState,
  end2: VentEndState,
  options: WallVentOptions = {},
): VentFlowResult {
  const f = vent.openFraction;
  const height = vent.soffitM - vent.sillM;
  const effWidth = vent.widthM * f;
  const area = height * effWidth;
  if (!(area >= VENT_MIN_AREA_M2)) return { transfers: [], openFraction: f, areaM2: 0 } satisfies VentFlowResult;
  const e1 = endGeometry(end1);
  const e2 = endGeometry(end2);
  const yvBot = vent.sillM + e1.zflor;
  const yvTop = vent.soffitM + e1.zflor;
  const slabs = buildSlabs(
    e1,
    e2,
    end1,
    end2,
    yvBot,
    yvTop,
    area,
    options.flowCoefficient ?? WALL_VENT_FLOW_COEFFICIENT,
    options.pressureEps ?? VENT_PRESSURE_EPS,
  );
  const ends = [end1, end2] as const;
  const zlay = [e1.zlay, e2.zlay] as const;
  const transfers = routeSlabs(slabs, ends, zlay);
  if (options.spillPlume !== false) {
    for (const t of spillPlumeTransfers(slabs, ends, zlay, yvBot, yvTop, effWidth)) transfers.push(t);
  }
  return { transfers, openFraction: f, areaM2: area };
}
