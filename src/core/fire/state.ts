// State vector layout of the implicit solver (design.md, Gas state module; Tech Ref appendix C, eq. C.3).
// Eight values per compartment, interleaved so that the unknowns of one compartment are adjacent:
//   [p, Vu, Tu, Tl, Tw_ceiling, Tw_upper_wall, Tw_lower_wall, Tw_floor]
// p is the gauge pressure at the floor, relative to the ambient pressure at the floor elevation (Pa).
// The surface order is the radiation order of Tech Ref section 5.1 (ceiling, upper wall, lower wall, floor).
import { clampUpperVolumeM3, initialUpperVolumeM3 } from "./gas/minVolume";
import { layerMassKg } from "./gas/layerEquations";
import type { Model } from "./model";
export const VARS_PER_COMPARTMENT = 8; // requirement 9.1: p, Vu, Tu, Tl and four surface temperatures
export const VAR_P = 0;
export const VAR_VU = 1;
export const VAR_TU = 2;
export const VAR_TL = 3;
export const VAR_TW = 4; // first of four surface temperatures
export const SURFACE_COUNT = 4;
export const SURFACE_CEILING = 0;
export const SURFACE_UPPER_WALL = 1;
export const SURFACE_LOWER_WALL = 2;
export const SURFACE_FLOOR = 3;
// Index of variable `variable` of compartment `compartment` in the state vector.
export function stateIndex(compartment: number, variable: number): number {
  return VARS_PER_COMPARTMENT * compartment + variable;
}
// Requirements 3.5, 8.2, design Gas state module "Initial state": p = 0, Vu = VMIN (VMAX for a shaft, Requirement 5.8),
// Tu = Tl = every surface temperature = the interior ambient temperature.
export function initialState(model: Model): Float64Array {
  const y = new Float64Array(VARS_PER_COMPARTMENT * model.compartments.length);
  model.compartments.forEach((c, i) => {
    const b = VARS_PER_COMPARTMENT * i;
    y[b + VAR_P] = 0;
    y[b + VAR_VU] = initialUpperVolumeM3(c.volumeM3, c.isShaft);
    y[b + VAR_TU] = model.interiorTempK;
    y[b + VAR_TL] = model.interiorTempK;
    for (let s = 0; s < SURFACE_COUNT; s++) y[b + VAR_TW + s] = model.interiorTempK;
  });
  return y;
}
// Tech Ref eq. 2.4 (m = P V / (R T)): initial gas mass of each layer node, lower layer first (species tracker node order,
// two nodes per compartment). The pressure is the ambient pressure at the compartment floor.
export function initialLayerMassesKg(model: Model): Float64Array {
  const out = new Float64Array(2 * model.compartments.length);
  model.compartments.forEach((c, i) => {
    const vu = initialUpperVolumeM3(c.volumeM3, c.isShaft);
    out[2 * i] = layerMassKg(c.ambientFloorPressurePa, c.volumeM3 - vu, model.interiorTempK);
    out[2 * i + 1] = layerMassKg(c.ambientFloorPressurePa, vu, model.interiorTempK);
  });
  return out;
}
// Requirement 3.6, design Gas state module "Clamping": after an accepted step the upper volume is projected into
// [VMIN, VMAX]. Works in place and returns true when a value changed, so the driver can update the BDF history.
export function projectUpperVolumes(model: Model, y: Float64Array): boolean {
  let changed = false;
  model.compartments.forEach((c, i) => {
    const k = stateIndex(i, VAR_VU);
    const v = y[k] as number;
    const clamped = clampUpperVolumeM3(v, c.volumeM3);
    if (clamped !== v && !Number.isNaN(v)) {
      y[k] = clamped;
      changed = true;
    }
  });
  return changed;
}
