// Shared shapes for the vent modules. Types and two small constructors, no physics of their own.
import { ambientDensityKgPerM3, ambientPressureAtPa } from "../gas/ambient";

export type VentLayer = "upper" | "lower";

// The gas state at one end of a vent. An end is a compartment or the Outside.
// All pressures are relative to one common reference (the ambient pressure at elevation 0), as CFAST `relp`.
export interface VentEndState {
  isOutside: boolean;
  floorElevationM: number; // absolute elevation of the floor, m
  heightM: number; // ceiling height above the floor, m
  interfaceHeightM: number; // layer interface above the floor, m (CFAST depth of the lower layer)
  floorPressurePa: number; // pressure at the floor minus the reference pressure, Pa
  upperTempK: number;
  lowerTempK: number;
  upperDensityKgPerM3: number;
  lowerDensityKgPerM3: number;
  // Outside only: ambient density at the ceiling elevation of the partner compartment (used by ceiling vents).
  ambientDensityAtCeilingKgPerM3?: number;
}

// A vertical vent also needs the layer volumes (CFAST 7.7.7 source, flowvertical.f90, vertical_flow).
export interface VerticalVentEndState extends VentEndState {
  upperVolumeM3: number;
  lowerVolumeM3: number;
  minVolumeM3: number; // VMIN of the compartment
}

// One mass transfer. Mass is conserved by construction: the same `massKgS` leaves (fromEnd, fromLayer) and enters (toEnd, toLayer).
// `sourceTempK` is the temperature of the gas that moves, so the enthalpy is cp * massKgS * sourceTempK.
// Species move with the composition of (fromEnd, fromLayer).
export interface MassTransfer {
  kind: "flow" | "entrainment";
  fromEnd: 0 | 1;
  fromLayer: VentLayer;
  toEnd: 0 | 1;
  toLayer: VentLayer;
  massKgS: number; // >= 0
  sourceTempK: number;
}

export interface VentFlowResult {
  transfers: MassTransfer[];
  openFraction: number;
  areaM2: number; // effective flow area, m2
}

export interface EndFlows {
  upperInKgS: number;
  upperOutKgS: number;
  lowerInKgS: number;
  lowerOutKgS: number;
}

// Requirement 4.9, 5.5: sum transfers into the four reported flows of each end. Entrainment inside one end is excluded unless asked for.
// Tech Ref eq. 2.5 to 2.8 (layer mass balance): the vent flows into and out of each layer of an end are the terms of the layer mass equations.
export function endFlows(transfers: readonly MassTransfer[], includeEntrainment = false): [EndFlows, EndFlows] {
  const zero = (): EndFlows => ({ upperInKgS: 0, upperOutKgS: 0, lowerInKgS: 0, lowerOutKgS: 0 });
  const ends: [EndFlows, EndFlows] = [zero(), zero()];
  for (const t of transfers) {
    if (t.kind === "entrainment" && !includeEntrainment) continue;
    const from = ends[t.fromEnd];
    const to = ends[t.toEnd];
    if (t.fromLayer === "upper") from.upperOutKgS += t.massKgS;
    else from.lowerOutKgS += t.massKgS;
    if (t.toLayer === "upper") to.upperInKgS += t.massKgS;
    else to.lowerInKgS += t.massKgS;
  }
  return ends;
}

// Ambient state outside the building, used to build the Outside end of a vent.
export interface OutsideAmbient {
  tempK: number; // exterior temperature
  pressureAtReferencePa: number; // absolute pressure at elevation 0
}

// Tech Ref eq. 2.4 and Requirement 2.5, CFAST 7.7.7 source, flowhorizontal.f90 (get_wall_flow_variables):
// the Outside end takes the floor elevation, height and interface of its partner, ambient temperature, and the ambient
// density and pressure at the partner's floor (exterior_den_initial, exterior_relp_initial).
export function outsideEnd(partner: VentEndState, ambient: OutsideAmbient): VentEndState {
  const floorAbsPa = ambientPressureAtPa(partner.floorElevationM, ambient.pressureAtReferencePa, ambient.tempK);
  const ceilingAbsPa = ambientPressureAtPa(
    partner.floorElevationM + partner.heightM,
    ambient.pressureAtReferencePa,
    ambient.tempK,
  );
  const density = ambientDensityKgPerM3(floorAbsPa, ambient.tempK);
  return {
    isOutside: true,
    floorElevationM: partner.floorElevationM,
    heightM: partner.heightM,
    interfaceHeightM: partner.interfaceHeightM,
    floorPressurePa: floorAbsPa - ambient.pressureAtReferencePa,
    upperTempK: ambient.tempK,
    lowerTempK: ambient.tempK,
    upperDensityKgPerM3: density,
    lowerDensityKgPerM3: density,
    ambientDensityAtCeilingKgPerM3: ambientDensityKgPerM3(ceilingAbsPa, ambient.tempK),
  };
}

// CFAST 7.7.7 source, flowhorizontal.f90 (get_wall_flow_variables, roomptr%relp): pressure at the floor relative to the
// common reference, from the gauge pressure (relative to ambient at the floor) used in the state vector.
export function floorPressureRelativeToReferencePa(
  gaugePressurePa: number,
  floorElevationM: number,
  ambient: OutsideAmbient,
): number {
  return (
    gaugePressurePa +
    ambientPressureAtPa(floorElevationM, ambient.pressureAtReferencePa, ambient.tempK) -
    ambient.pressureAtReferencePa
  );
}
