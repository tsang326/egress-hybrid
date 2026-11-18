// buildModel: everything about a Scenario that does not change during a run (design.md, Module layout, model.ts).
// Geometry, vent topology, leakage vents, ambient state, solver tolerances and the Jacobian colouring.
// Pure data. Mutable work space (wall profiles, scratch arrays) lives in residual.ts, so one Model can be shared.
import { ATOL_PRESSURE_PA, ATOL_TEMPERATURE_K, ATOL_VOLUME_M3 } from "./constants";
import { ambientPressureAtPa } from "./gas/ambient";
import { maxLayerVolumeM3, minLayerVolumeM3 } from "./gas/minVolume";
import type { JacobianSparsity } from "./solver/jacobian";
import { buildSparsity } from "./solver/jacobian";
import { SPECIES_COUNT } from "./species/tracker";
import type {
  Ambient,
  Compartment,
  Fire,
  OpenFractionTable,
  Scenario,
  Surface,
} from "./types";
import { buildLeakageVents, leakageGeometry, type LeakageGeometry } from "./vents/leakage";
import type { OutsideAmbient } from "./vents/ventTypes";
import { VARS_PER_COMPARTMENT, VAR_P, VAR_TL, VAR_TU, VAR_VU } from "./state";
// Smallest finite-difference perturbation of each unknown type: the absolute error tolerance of that unknown.
// numerical parameter, not from Tech Ref (design Solver design, Jacobian).
// The pressure step is far below the absolute tolerance: vent flows are damped over a pressure scale of about
// VENT_DELP_CUT_FACTOR * VENT_PRESSURE_EPS = 1e-5 Pa (CFAST 7.7.7 source, flowhorizontal.f90, delp), and a larger step
// would straddle the square-root nonlinearity of the flow near zero pressure difference.
const DELTA_MIN_PRESSURE_PA = 1e-7;
const DELTA_MIN_VOLUME_M3 = ATOL_VOLUME_M3;
const DELTA_MIN_TEMPERATURE_K = ATOL_TEMPERATURE_K;
export interface SurfaceModel {
  surface: Surface; // the construction (shared object for the four walls)
  adiabaticMarker: boolean; // explicit adiabatic surface (CFAST material OFF, Requirement 2.4): no heat transfer
  emissivity: number; // of the exposed layer, 0 for an adiabatic surface (design Heat transfer modules)
  k1WPerMK: number; // conductivity of the first layer, 0 for an adiabatic surface
  horizontal: boolean; // ceiling and floor use the horizontal convection constant
  upperGas: boolean; // true: driven by the upper layer (ceiling, upper wall); false: lower layer
}
export interface CompartmentModel {
  id: string;
  index: number;
  widthM: number;
  depthM: number;
  heightM: number;
  floorAreaM2: number;
  volumeM3: number;
  floorElevationM: number;
  isShaft: boolean; // kind === "shaft": single well-mixed zone (Requirement 5.8)
  vminM3: number; // Requirement 3.5
  vmaxM3: number;
  wallPerimeterM: number; // 2 (W + D), used for the areas of the upper and lower wall
  ambientFloorPressurePa: number; // absolute ambient pressure at the floor (Requirement 2.5)
  ambientFloorRelativePa: number; // the same, minus the pressure at the reference elevation
  surfaces: readonly SurfaceModel[]; // SURFACE_COUNT entries in radiation order
  fires: readonly number[]; // indices into Model.fires
}
export interface FireModel {
  index: number;
  compartment: number;
  fire: Fire;
}
// Vent ends: compartment index, or -1 for the Outside.
export interface WallVentModel {
  kind: "wall";
  id: string;
  ends: readonly [number, number]; // [from, to]
  sillM: number;
  soffitM: number;
  widthM: number;
  open: number | OpenFractionTable;
}
export interface CeilingFloorVentModel {
  kind: "ceilingFloor";
  id: string;
  ends: readonly [number, number]; // [upper compartment (CFAST itop, end 0), lower compartment (ibot, end 1)]
  areaM2: number;
  shape: "round" | "square";
  open: number | OpenFractionTable;
}
export interface LeakageVentModel {
  kind: "leakage";
  id: string;
  ends: readonly [number, number]; // [compartment, -1]
  geometry: LeakageGeometry;
  fromRatio: boolean; // built from a compartment's leakage area ratio, not listed in Scenario.vents
}
export type VentModel = WallVentModel | CeilingFloorVentModel | LeakageVentModel;
export interface Model {
  scenario: Scenario;
  compartments: readonly CompartmentModel[];
  fires: readonly FireModel[];
  vents: readonly VentModel[];
  userVentCount: number; // vents[0 .. userVentCount) come from Scenario.vents, the rest from leakage ratios
  ambient: Ambient;
  outsideAmbient: OutsideAmbient;
  interiorTempK: number;
  exteriorTempK: number;
  adiabatic: boolean;
  cfastUpperPlumeArgOrder: boolean;
  maxTimeStepS: number | undefined;
  // Ambient mass fractions in species tracker order (o2, co2, co, h2o, soot, n2, uhc); n2 is the remainder.
  ambientSpeciesFractions: Float64Array;
  nUnknowns: number;
  sparsity: JacobianSparsity;
  atol: Float64Array;
  deltaMin: Float64Array;
  differential: Uint8Array; // 1 for rows of the form y' - f, 0 for the algebraic surface rows
}
function surfaceModel(surface: Surface, horizontal: boolean, upperGas: boolean): SurfaceModel {
  if ("adiabatic" in surface) {
    return { surface, adiabaticMarker: true, emissivity: 0, k1WPerMK: 0, horizontal, upperGas };
  }
  const first = surface.layers[0];
  return {
    surface,
    adiabaticMarker: false,
    emissivity: first?.emissivity ?? 0,
    k1WPerMK: first?.conductivityWPerMK ?? 0,
    horizontal,
    upperGas,
  };
}
function compartmentModel(c: Compartment, index: number, ambient: Ambient, fires: number[]): CompartmentModel {
  const volume = c.widthM * c.depthM * c.heightM;
  const floorPa = ambientPressureAtPa(c.floorElevationM, ambient.pressurePa, ambient.exteriorTempK);
  return {
    id: c.id,
    index,
    widthM: c.widthM,
    depthM: c.depthM,
    heightM: c.heightM,
    floorAreaM2: c.widthM * c.depthM,
    volumeM3: volume,
    floorElevationM: c.floorElevationM,
    isShaft: c.kind === "shaft",
    vminM3: minLayerVolumeM3(volume),
    vmaxM3: maxLayerVolumeM3(volume),
    wallPerimeterM: 2 * (c.widthM + c.depthM),
    ambientFloorPressurePa: floorPa,
    ambientFloorRelativePa: floorPa - ambient.pressurePa,
    // Tech Ref 5.1 and Requirement 2.3: one construction for the ceiling, one for the floor, one shared by both wall surfaces.
    surfaces: [
      surfaceModel(c.ceiling, true, true),
      surfaceModel(c.walls, false, true),
      surfaceModel(c.walls, false, false),
      surfaceModel(c.floor, true, false),
    ],
    fires,
  };
}
// Unknown compartment ids are a programmer error here: the Input_Validator rejects them before a run (Requirement 1.5).
function endIndex(ids: ReadonlyMap<string, number>, id: string): number {
  if (id === "OUTSIDE") return -1;
  const i = ids.get(id);
  if (i === undefined) throw new TypeError(`buildModel: unknown compartment id "${id}"`);
  return i;
}
// Rows of the residual that depend on each unknown. Design Solver design, Jacobian: a compartment's residual depends only
// on its own unknowns and on the gas state (p, Vu, Tu, Tl) of the compartments joined to it by a vent. Surface
// temperatures of a compartment change only its own rows.
function rowsOfColumns(nC: number, vents: readonly VentModel[]): Int32Array[] {
  const neighbours: Set<number>[] = Array.from({ length: nC }, () => new Set<number>());
  for (const v of vents) {
    const [a, b] = v.ends;
    if (a >= 0 && b >= 0 && a !== b) {
      neighbours[a]?.add(b);
      neighbours[b]?.add(a);
    }
  }
  const cols: Int32Array[] = [];
  for (let c = 0; c < nC; c++) {
    const own: number[] = [];
    for (let v = 0; v < VARS_PER_COMPARTMENT; v++) own.push(VARS_PER_COMPARTMENT * c + v);
    // Neighbours in ascending order, so the result does not depend on set insertion order.
    const near = [...(neighbours[c] as Set<number>)].sort((x, y) => x - y);
    for (let v = 0; v < VARS_PER_COMPARTMENT; v++) {
      const rows = [...own];
      if (v < VAR_TL + 1) {
        // Gas variable: also drives the gas rows (p, Vu, Tu, Tl) of every neighbour.
        for (const n of near) for (let r = 0; r <= VAR_TL; r++) rows.push(VARS_PER_COMPARTMENT * n + r);
      }
      rows.sort((x, y) => x - y);
      cols.push(Int32Array.from(rows));
    }
  }
  return cols;
}
// Requirements 2.1, 2.3, 4.1, 5.8: build the immutable model of a validated Scenario.
// Fixed iteration order everywhere (input order, then leakage vents), so the colouring is deterministic (Requirement 11.4).
export function buildModel(scenario: Scenario): Model {
  const ambient = scenario.ambient;
  const ids = new Map<string, number>();
  scenario.compartments.forEach((c, i) => ids.set(c.id, i));
  const firesByCompartment: number[][] = scenario.compartments.map(() => []);
  const fires: FireModel[] = scenario.fires.map((fire, index) => {
    const compartment = endIndex(ids, fire.compartmentId);
    if (compartment < 0) throw new TypeError(`buildModel: fire "${fire.id}" is placed in the Outside`);
    (firesByCompartment[compartment] as number[]).push(index);
    return { index, compartment, fire };
  });
  const compartments = scenario.compartments.map((c, i) =>
    compartmentModel(c, i, ambient, firesByCompartment[i] as number[]),
  );
  const vents: VentModel[] = [];
  for (const v of scenario.vents) {
    if (v.kind === "wall") {
      vents.push({
        kind: "wall",
        id: v.id,
        ends: [endIndex(ids, v.from), endIndex(ids, v.to)],
        sillM: v.sillM,
        soffitM: v.soffitM,
        widthM: v.widthM,
        open: v.open,
      });
    } else if (v.kind === "ceilingFloor") {
      vents.push({
        kind: "ceilingFloor",
        id: v.id,
        ends: [endIndex(ids, v.upper), endIndex(ids, v.lower)],
        areaM2: v.areaM2,
        shape: v.shape,
        open: v.open,
      });
    } else {
      const ci = endIndex(ids, v.compartmentId);
      const box = scenario.compartments[ci] as Compartment;
      vents.push({
        kind: "leakage",
        id: v.id,
        ends: [ci, -1],
        geometry: leakageGeometry(v.id, v.compartmentId, box, v.orientation, v.areaM2),
        fromRatio: false,
      });
    }
  }
  const userVentCount = vents.length;
  // Requirement 4.7, Tech Ref section 4.4: leakage from the area ratios of each compartment, to the Outside only.
  for (const g of buildLeakageVents(scenario.compartments)) {
    vents.push({ kind: "leakage", id: g.id, ends: [endIndex(ids, g.compartmentId), -1], geometry: g, fromRatio: true });
  }
  const nC = compartments.length;
  const nUnknowns = VARS_PER_COMPARTMENT * nC;
  const atol = new Float64Array(nUnknowns);
  const deltaMin = new Float64Array(nUnknowns);
  const differential = new Uint8Array(nUnknowns);
  for (let c = 0; c < nC; c++) {
    const b = VARS_PER_COMPARTMENT * c;
    atol[b + VAR_P] = ATOL_PRESSURE_PA;
    deltaMin[b + VAR_P] = DELTA_MIN_PRESSURE_PA;
    atol[b + VAR_VU] = ATOL_VOLUME_M3;
    deltaMin[b + VAR_VU] = DELTA_MIN_VOLUME_M3;
    for (let v = VAR_TU; v < VARS_PER_COMPARTMENT; v++) {
      atol[b + v] = ATOL_TEMPERATURE_K;
      deltaMin[b + v] = DELTA_MIN_TEMPERATURE_K;
    }
    for (let v = 0; v <= VAR_TL; v++) differential[b + v] = 1;
  }
  const s = ambient.species;
  const frac = new Float64Array(SPECIES_COUNT);
  frac[0] = s.o2;
  frac[1] = s.co2;
  frac[2] = s.co;
  frac[3] = s.h2o;
  frac[4] = s.soot;
  frac[5] = Math.max(0, 1 - s.o2 - s.co2 - s.co - s.h2o - s.soot); // N2, the remainder (Requirement 8.7)
  frac[6] = 0; // no unburned hydrocarbon in ambient air
  return {
    scenario,
    compartments,
    fires,
    vents,
    userVentCount,
    ambient,
    outsideAmbient: { tempK: ambient.exteriorTempK, pressureAtReferencePa: ambient.pressurePa },
    interiorTempK: ambient.interiorTempK,
    exteriorTempK: ambient.exteriorTempK,
    adiabatic: scenario.options?.adiabatic === true,
    cfastUpperPlumeArgOrder: scenario.options?.cfastUpperPlumeArgOrder === true,
    maxTimeStepS: scenario.options?.maxTimeStepS,
    ambientSpeciesFractions: frac,
    nUnknowns,
    sparsity: buildSparsity(rowsOfColumns(nC, vents), nUnknowns),
    atol,
    deltaMin,
    differential,
  };
}
