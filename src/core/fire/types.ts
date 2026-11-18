// Shape of the fire-zone input and output. Types only, no logic.
// All quantities are SI (m, s, kg, K, W, Pa). Names carry the unit when it is not obvious.
import type { Warning } from "./validate/warnings";

export type { Warning } from "./validate/warnings";

export interface Scenario {
  schemaVersion: 1;
  title?: string;
  durationS: number;
  printIntervalS: number;
  seed: number; // Seeded_PRNG seed, unused by physics in v1 (Req 11.3)
  ambient: Ambient;
  options?: ScenarioOptions;
  compartments: Compartment[];
  vents: Vent[];
  fires: Fire[];
  unsupported?: UnsupportedItem[];
}

export interface ScenarioOptions {
  maxTimeStepS?: number;
  adiabatic?: boolean;
  // Req 6.13. false (default): upper-layer plume arguments in their intended meaning.
  // true: reproduce the argument order of CFAST 7.7.7 fire.f90, do_fire.
  cfastUpperPlumeArgOrder?: boolean;
}

export interface Ambient {
  interiorTempK: number;
  exteriorTempK: number;
  pressurePa: number; // absolute, at elevation 0
  species: { o2: number; co2: number; co: number; h2o: number; soot: number }; // mass fractions
}

export type CompartmentKind = "room" | "corridor" | "shaft";

export interface Compartment {
  id: string;
  widthM: number;
  depthM: number;
  heightM: number;
  floorElevationM: number;
  kind: CompartmentKind;
  isStair?: boolean;
  ceiling: Surface;
  floor: Surface;
  walls: Surface; // one construction shared by all four walls (Req 2.3)
  leakage?: { wallAreaRatio?: number; floorAreaRatio?: number }; // to the Outside only (Req 4.7)
}

// Exposed face first, 1 to 3 layers; or an explicit adiabatic surface (CFAST material OFF).
export type Surface = { layers: SurfaceLayer[] } | { adiabatic: true };

export interface SurfaceLayer {
  name: string;
  conductivityWPerMK: number;
  densityKgPerM3: number;
  specificHeatJPerKgK: number;
  thicknessM: number;
  emissivity: number; // emissivity of the exposed layer is used for radiation
}

export type Face = "front" | "back" | "left" | "right";
export type VentEnd = string; // a compartment id, or "OUTSIDE"
export interface OpenFractionTable {
  timesS: number[];
  fractions: number[];
} // 2 to 1,000 pairs

export type Vent = WallVent | CeilingFloorVent | LeakageVent;

export interface WallVent {
  kind: "wall";
  id: string;
  from: VentEnd;
  to: VentEnd;
  sillM: number;
  soffitM: number;
  widthM: number;
  face: Face;
  offsetM: number;
  open: number | OpenFractionTable;
}

export interface CeilingFloorVent {
  kind: "ceilingFloor";
  id: string;
  lower: VentEnd;
  upper: VentEnd;
  areaM2: number;
  shape: "round" | "square";
  offsetM?: [number, number];
  open: number | OpenFractionTable;
}

export interface LeakageVent {
  kind: "leakage";
  id: string;
  compartmentId: string; // the other end is always the Outside (Req 4.7)
  areaM2: number; // 0 < area <= 100
  orientation: "wall" | "floor";
}

export interface HrrRow {
  timeS: number;
  hrrW: number;
  heightM: number;
  areaM2: number;
  coYield: number; // kg/kg
  sootYield: number; // kg/kg
}

export interface Fire {
  id: string;
  compartmentId: string;
  xM: number;
  yM: number;
  radiativeFraction: number; // 0..1
  ignitionTimeS?: number; // default 0; table time is t - ignitionTimeS
  fuel: {
    c: number;
    h: number;
    o: number;
    n: number;
    cl: number;
    heatOfCombustionJPerKg: number;
  };
  table: HrrRow[]; // 2 to 10,000 rows
}

export interface UnsupportedItem {
  kind: "hvac" | "sprinkler" | "detector" | "suppression" | "target";
  id: string;
}

export type ResultStatus = "ok" | "invalid" | "failed";

export interface ResultFlag {
  warningIndex: number; // index into Result.warnings
  target: { kind: "compartment" | "vent"; id: string };
  quantities: "all" | string[];
}

export interface ResultStats {
  steps: number;
  rejected: number;
  newtonIterations: number;
  jacobians: number;
  maxUpperBurnHrrW: number; // largest upper-layer burned HRR over the run (Property 35)
  stepSizesS?: Float64Array; // only filled when RunOptions.recordSteps is true
}

export interface Result {
  status: ResultStatus;
  warnings: Warning[];
  flags: ResultFlag[];
  timesS: Float64Array; // sample times
  compartments: CompartmentSeries[];
  vents: VentSeries[];
  stats: ResultStats;
}

export interface LayerSeries {
  o2: Float64Array;
  co2: Float64Array;
  co: Float64Array;
  h2o: Float64Array;
  soot: Float64Array;
  opticalDensityPerM: Float64Array;
  visibilityM: Float64Array; // Infinity when soot is 0
}

export interface CompartmentSeries {
  id: string;
  upperTempK: Float64Array;
  lowerTempK: Float64Array;
  interfaceHeightM: Float64Array;
  pressurePa: Float64Array; // absolute
  upperVolumeM3: Float64Array;
  upper: LayerSeries;
  lower: LayerSeries;
  burnedHrrW: { fireId: string; values: Float64Array }[];
}

export interface VentEndSeries {
  compartmentId: string; // a compartment id, or "OUTSIDE"
  upperInKgS: Float64Array;
  upperOutKgS: Float64Array;
  lowerInKgS: Float64Array;
  lowerOutKgS: Float64Array;
}

export interface VentSeries {
  id: string;
  // ends[0] is ALWAYS the vent's FIRST compartment: `from` of a wall vent, `upper` of a ceiling/floor vent (CFAST lists the
  // top compartment first in COMP_IDS), the leaking compartment of a leakage vent. ends[1] is the other end, which is
  // "OUTSIDE" for leakage. The CFAST CSV layer flows are relative to the first compartment, and validation/harness/compare.ts
  // compares them with ends[0], so this order is part of the Result contract.
  ends: [VentEndSeries, VentEndSeries];
  openFraction: Float64Array;
}

export interface ProgressEvent {
  simTimeS: number;
  fraction: number; // 0..1
}

export interface RunOptions {
  onProgress?: (e: ProgressEvent) => void; // Req 10.5
  // Wall clock for the 1 s progress rule, injected so core stays pure (Req 11.4). Returns milliseconds, like
  // performance.now. Wall-clock values never reach the Result.
  now?: () => number;
  recordSteps?: boolean; // fill stats.stepSizesS (Req 9.8)
  // Test-only numerical override (Requirement 14.2 convergence check). Default behaviour is unchanged when absent.
  numerical?: { rtol?: number };
}
