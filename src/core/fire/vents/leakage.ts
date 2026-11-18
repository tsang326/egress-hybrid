// Leakage vents: small openings between a compartment and the Outside, built before the run and evaluated by the wall vent code.
// Pure functions, SI units.
//
// Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage) and flowhorizontal.f90 (leakage_flow).
import {
  LEAKAGE_FLOOR_WIDTH_FRACTION,
  LEAKAGE_WALL_SILL_FRACTION,
  LEAKAGE_WALL_SOFFIT_FRACTION,
  WALL_VENT_FLOW_COEFFICIENT,
} from "../constants";
import type { Compartment } from "../types";
import { wallVentFlows, type WallVentGeometry } from "./wallVent";
import type { VentEndState, VentFlowResult } from "./ventTypes";

export type LeakageOrientation = "wall" | "floor";

export interface LeakageGeometry extends WallVentGeometry {
  id: string;
  compartmentId: string;
  orientation: LeakageOrientation;
}

type Box = Pick<Compartment, "widthM" | "depthM" | "heightM">;

// Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage): wall leakage as a vent along the wall,
// sill at 5 % and soffit at 95 % of the ceiling height. The width gives the requested area: area / (soffit - sill).
export function wallLeakageFromAreaM2(box: Box, areaM2: number): Pick<WallVentGeometry, "sillM" | "soffitM" | "widthM"> {
  const sillM = box.heightM * LEAKAGE_WALL_SILL_FRACTION;
  const soffitM = box.heightM * LEAKAGE_WALL_SOFFIT_FRACTION;
  return { sillM, soffitM, widthM: areaM2 / (soffitM - sillM) };
}

// Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage): floor leakage as a vent at floor level
// of width 0.9 (W + D) / 2 and a height (soffit, sill 0) that gives the requested area.
export function floorLeakageFromAreaM2(box: Box, areaM2: number): Pick<WallVentGeometry, "sillM" | "soffitM" | "widthM"> {
  const widthM = (LEAKAGE_FLOOR_WIDTH_FRACTION * (box.widthM + box.depthM)) / 2;
  return { sillM: 0, soffitM: areaM2 / widthM, widthM };
}

// CFAST 7.7.7 source, initialization.f90 (initialize_leakage): wall area 2 (W + D) H, floor area W D, in m2.
export function leakageSurfaceAreaM2(box: Box, orientation: LeakageOrientation): number {
  return orientation === "wall" ? 2 * (box.widthM + box.depthM) * box.heightM : box.widthM * box.depthM;
}

// Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage): geometry of one leakage vent of a
// given area. Always fully open (open fraction 1). Area must be positive; the validator enforces 0 < area <= 100 m2.
export function leakageGeometry(
  id: string,
  compartmentId: string,
  box: Box,
  orientation: LeakageOrientation,
  areaM2: number,
): LeakageGeometry {
  const g = orientation === "wall" ? wallLeakageFromAreaM2(box, areaM2) : floorLeakageFromAreaM2(box, areaM2);
  return { id, compartmentId, orientation, openFraction: 1, ...g };
}

// Tech Ref section 4.4, CFAST 7.7.7 source, initialization.f90 (initialize_leakage): leakage vents to the Outside from the
// area ratios of each compartment (leakage area divided by wall area, or by floor area). A ratio of 0 or missing gives none.
// Order: compartments in input order; wall leak before floor leak. Leakage between two compartments is not supported (Requirement 4.7).
export function buildLeakageVents(compartments: readonly Compartment[]): LeakageGeometry[] {
  const out: LeakageGeometry[] = [];
  for (const c of compartments) {
    const wallRatio = c.leakage?.wallAreaRatio ?? 0;
    if (wallRatio > 0) {
      out.push(leakageGeometry(`Wall Leak ${c.id}`, c.id, c, "wall", wallRatio * leakageSurfaceAreaM2(c, "wall")));
    }
    const floorRatio = c.leakage?.floorAreaRatio ?? 0;
    if (floorRatio > 0) {
      out.push(leakageGeometry(`Floor Leak ${c.id}`, c.id, c, "floor", floorRatio * leakageSurfaceAreaM2(c, "floor")));
    }
  }
  return out;
}

// Requirements 4.1, 4.5, 4.8, CFAST 7.7.7 source, flowhorizontal.f90 (leakage_flow): flow through one leakage vent.
// Computed by the wall vent code with C = 0.7, open fraction 1 and no spill plume entrainment. `compartment` is end 0,
// the Outside end (see `outsideEnd`) is end 1. Exactly zero when height x width < 1e-10 m2. Mass is conserved by construction.
export function leakageFlows(vent: LeakageGeometry, compartment: VentEndState, outside: VentEndState): VentFlowResult {
  return wallVentFlows({ ...vent, openFraction: 1 }, compartment, outside, {
    spillPlume: false,
    flowCoefficient: WALL_VENT_FLOW_COEFFICIENT,
  });
}
