// Result builders and sample recording (design.md, Module layout, result.ts; Requirements 4.9, 8.9, 10.1, 10.7 to 10.9).
// A Recorder owns preallocated series for the whole run. `recordSample` copies one sample out of the residual work
// space after an evaluation at the accepted state. `finishResult` trims the series to the samples that exist, so a failed
// run keeps exactly the samples taken before the failure.
import { SPECIES_CO, SPECIES_CO2, SPECIES_H2O, SPECIES_O2, SPECIES_SOOT, LAYER_LOWER, LAYER_UPPER, layerNode, massFraction } from "./species/tracker";
import { layerSmoke } from "./species/visibility";
import type { Model } from "./model";
import type { Workspace } from "./residual";
import { VARS_PER_COMPARTMENT, VAR_P } from "./state";
import type {
  CompartmentSeries,
  LayerSeries,
  Result,
  ResultFlag,
  ResultStats,
  ResultStatus,
  VentEndSeries,
  VentSeries,
  Warning,
} from "./types";
import type { VerticalVentEndState } from "./vents/ventTypes";
import { endFlows } from "./vents/ventTypes";

const OUTSIDE_ID = "OUTSIDE";

interface LayerBuffers {
  o2: Float64Array;
  co2: Float64Array;
  co: Float64Array;
  h2o: Float64Array;
  soot: Float64Array;
  opticalDensityPerM: Float64Array;
  visibilityM: Float64Array;
}

interface CompartmentBuffers {
  id: string;
  upperTempK: Float64Array;
  lowerTempK: Float64Array;
  interfaceHeightM: Float64Array;
  pressurePa: Float64Array;
  upperVolumeM3: Float64Array;
  upper: LayerBuffers;
  lower: LayerBuffers;
  burnedHrrW: { fireId: string; values: Float64Array }[];
}

interface VentEndBuffers {
  compartmentId: string;
  upperInKgS: Float64Array;
  upperOutKgS: Float64Array;
  lowerInKgS: Float64Array;
  lowerOutKgS: Float64Array;
}

interface VentBuffers {
  id: string;
  ends: [VentEndBuffers, VentEndBuffers];
  openFraction: Float64Array;
}

export interface Recorder {
  /** Number of samples recorded so far. */
  count: number;
  readonly capacity: number;
  readonly timesS: Float64Array;
  readonly compartments: CompartmentBuffers[];
  readonly vents: VentBuffers[];
}

function layerBuffers(n: number): LayerBuffers {
  return {
    o2: new Float64Array(n),
    co2: new Float64Array(n),
    co: new Float64Array(n),
    h2o: new Float64Array(n),
    soot: new Float64Array(n),
    opticalDensityPerM: new Float64Array(n),
    visibilityM: new Float64Array(n),
  };
}

function ventEndBuffers(compartmentId: string, n: number): VentEndBuffers {
  return {
    compartmentId,
    upperInKgS: new Float64Array(n),
    upperOutKgS: new Float64Array(n),
    lowerInKgS: new Float64Array(n),
    lowerOutKgS: new Float64Array(n),
  };
}

function endId(model: Model, index: number): string {
  return index >= 0 ? (model.compartments[index]?.id ?? OUTSIDE_ID) : OUTSIDE_ID;
}

/** Allocates the series for `sampleTimesS.length` samples (Requirement 10.2). The times are stored when a sample is recorded. */
export function createRecorder(model: Model, capacity: number): Recorder {
  return {
    count: 0,
    capacity,
    timesS: new Float64Array(capacity),
    compartments: model.compartments.map((c) => ({
      id: c.id,
      upperTempK: new Float64Array(capacity),
      lowerTempK: new Float64Array(capacity),
      interfaceHeightM: new Float64Array(capacity),
      pressurePa: new Float64Array(capacity),
      upperVolumeM3: new Float64Array(capacity),
      upper: layerBuffers(capacity),
      lower: layerBuffers(capacity),
      burnedHrrW: c.fires.map((fi) => ({
        fireId: model.fires[fi]?.fire.id ?? "",
        values: new Float64Array(capacity),
      })),
    })),
    // Requirement 4.9: ends[0] is the first compartment of the vent (model ends are already in that order).
    vents: model.vents.map((v) => ({
      id: v.id,
      ends: [ventEndBuffers(endId(model, v.ends[0]), capacity), ventEndBuffers(endId(model, v.ends[1]), capacity)],
      openFraction: new Float64Array(capacity),
    })),
  };
}

function recordLayer(
  buf: LayerBuffers,
  k: number,
  ws: Workspace,
  node: number,
  densityKgPerM3: number,
): void {
  const s = ws.species;
  const soot = massFraction(s, node, SPECIES_SOOT);
  buf.o2[k] = massFraction(s, node, SPECIES_O2);
  buf.co2[k] = massFraction(s, node, SPECIES_CO2);
  buf.co[k] = massFraction(s, node, SPECIES_CO);
  buf.h2o[k] = massFraction(s, node, SPECIES_H2O);
  buf.soot[k] = soot;
  const smoke = layerSmoke(soot, densityKgPerM3); // Tech Ref eq. 6.3; Infinity visibility at zero soot (Requirement 8.6)
  buf.opticalDensityPerM[k] = smoke.opticalDensityPerM;
  buf.visibilityM[k] = smoke.visibilityM;
}

/**
 * Records one sample at time `timeS`. `ws` must hold an evaluation (evaluateModel) at the state `y`, and the species
 * state at the same time. Requirements 10.1, 10.7.
 */
export function recordSample(rec: Recorder, model: Model, ws: Workspace, y: Float64Array, timeS: number): void {
  const k = rec.count;
  if (k >= rec.capacity) return;
  rec.timesS[k] = timeS;
  model.compartments.forEach((c, i) => {
    const buf = rec.compartments[i] as CompartmentBuffers;
    const e = ws.ends[i] as VerticalVentEndState;
    buf.upperTempK[k] = e.upperTempK;
    buf.lowerTempK[k] = e.lowerTempK;
    buf.interfaceHeightM[k] = e.interfaceHeightM; // Requirement 3.4, within [0, H] by the clamp of Requirement 3.6
    buf.pressurePa[k] = c.ambientFloorPressurePa + (y[VARS_PER_COMPARTMENT * i + VAR_P] as number);
    buf.upperVolumeM3[k] = e.upperVolumeM3;
    const upperNode = layerNode(i, LAYER_UPPER);
    const lowerNode = layerNode(i, LAYER_LOWER);
    recordLayer(buf.upper, k, ws, upperNode, e.upperDensityKgPerM3);
    recordLayer(buf.lower, k, ws, lowerNode, e.lowerDensityKgPerM3);
    c.fires.forEach((fi, j) => {
      const series = buf.burnedHrrW[j];
      if (series !== undefined) series.values[k] = ws.fireEvals[fi]?.hrrW ?? 0;
    });
  });
  model.vents.forEach((_v, vi) => {
    const buf = rec.vents[vi] as VentBuffers;
    const r = ws.ventResults[vi];
    if (r === null || r === undefined) return; // not evaluated: zeros
    const [a, b] = endFlows(r.transfers);
    const put = (end: VentEndBuffers, f: typeof a): void => {
      end.upperInKgS[k] = f.upperInKgS;
      end.upperOutKgS[k] = f.upperOutKgS;
      end.lowerInKgS[k] = f.lowerInKgS;
      end.lowerOutKgS[k] = f.lowerOutKgS;
    };
    put(buf.ends[0], a);
    put(buf.ends[1], b);
    buf.openFraction[k] = r.openFraction;
  });
  rec.count = k + 1;
}

function trim(a: Float64Array, n: number): Float64Array {
  return n === a.length ? a : a.slice(0, n);
}

function trimLayer(l: LayerBuffers, n: number): LayerSeries {
  return {
    o2: trim(l.o2, n),
    co2: trim(l.co2, n),
    co: trim(l.co, n),
    h2o: trim(l.h2o, n),
    soot: trim(l.soot, n),
    opticalDensityPerM: trim(l.opticalDensityPerM, n),
    visibilityM: trim(l.visibilityM, n),
  };
}

function trimVentEnd(e: VentEndBuffers, n: number): VentEndSeries {
  return {
    compartmentId: e.compartmentId,
    upperInKgS: trim(e.upperInKgS, n),
    upperOutKgS: trim(e.upperOutKgS, n),
    lowerInKgS: trim(e.lowerInKgS, n),
    lowerOutKgS: trim(e.lowerOutKgS, n),
  };
}

export function emptyStats(): ResultStats {
  return { steps: 0, rejected: 0, newtonIterations: 0, jacobians: 0, maxUpperBurnHrrW: 0 };
}

/** Requirements 10.8, 10.9: the Result of a run that recorded `rec.count` samples, trimmed to those samples. */
export function finishResult(
  rec: Recorder,
  status: ResultStatus,
  warnings: Warning[],
  flags: ResultFlag[],
  stats: ResultStats,
): Result {
  const n = rec.count;
  const compartments: CompartmentSeries[] = rec.compartments.map((c) => ({
    id: c.id,
    upperTempK: trim(c.upperTempK, n),
    lowerTempK: trim(c.lowerTempK, n),
    interfaceHeightM: trim(c.interfaceHeightM, n),
    pressurePa: trim(c.pressurePa, n),
    upperVolumeM3: trim(c.upperVolumeM3, n),
    upper: trimLayer(c.upper, n),
    lower: trimLayer(c.lower, n),
    burnedHrrW: c.burnedHrrW.map((b) => ({ fireId: b.fireId, values: trim(b.values, n) })),
  }));
  const vents: VentSeries[] = rec.vents.map((v) => ({
    id: v.id,
    ends: [trimVentEnd(v.ends[0], n), trimVentEnd(v.ends[1], n)],
    openFraction: trim(v.openFraction, n),
  }));
  return { status, warnings, flags, timesS: trim(rec.timesS, n), compartments, vents, stats };
}

/** A Result with no samples: a rejected Scenario ("invalid") or a failure before the first sample. */
export function emptyResult(status: ResultStatus, warnings: Warning[], flags: ResultFlag[]): Result {
  return {
    status,
    warnings,
    flags,
    timesS: new Float64Array(0),
    compartments: [],
    vents: [],
    stats: emptyStats(),
  };
}
