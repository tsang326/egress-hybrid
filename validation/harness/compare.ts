// Tolerance logic for the CFAST comparison (fire-zone Req 13.1, 13.4 to 13.7) and the
// CFAST-order versus intended-order difference (Req 6.13). Node and test use only; pure functions, never throws.
//
// Checks per compartment (CSV entity = compartment id): upper and lower layer Rise, interface height.
// Checks per vent (CSV entity = vent id): the four layer flows. CSV layer flows are relative to the FIRST
// compartment of the vent (design.md, Reference CSV reader), so they are compared with `ends[0]` of the model.

import type { CompartmentSeries, Result, VentEndSeries } from '../../src/core/fire/types';
import { findColumn, type ReferenceTable, type VentQuantity } from './referenceCsv';
import {
  COMPARE_START_TIME_S,
  INTERFACE_HEIGHT_ABS_TOL_M,
  RISE_ABS_TOL_K,
  RISE_REL_TOL,
  VENT_FLOW_ABS_TOL_KG_S,
  VENT_FLOW_REL_TOL,
} from './tolerances';

/** Largest gap in s between a CSV row time and the model sample time that still counts as the same time. */
const TIME_MATCH_S = 1e-6; // both sides print times with at least 1e-6 s resolution at a 10 s interval

export interface CheckFailure {
  /** For example "upper layer Rise (K)" or "wall vent flow, upper inflow (kg/s)". */
  readonly quantity: string;
  readonly entity: string;
  readonly timeS: number;
  readonly cfastValue: number;
  readonly modelValue: number;
  /** model - CFAST. */
  readonly difference: number;
}

/** Per quantity and entity: how many points were checked and the point of the largest violation. */
export interface QuantitySummary {
  readonly quantity: string;
  readonly entity: string;
  readonly pointsChecked: number;
  readonly failures: number;
  /** Largest |difference| / allowed difference. Above 1 means a failure. */
  readonly worstRatio: number;
  readonly worstTimeS: number;
  readonly worstCfastValue: number;
  readonly worstModelValue: number;
}

export interface CaseComparison {
  /** True only if nothing failed and every CSV time of 60 s or later has a model sample. */
  readonly passed: boolean;
  readonly failures: readonly CheckFailure[];
  readonly summaries: readonly QuantitySummary[];
  /** CSV times (>= 60 s) without a model sample. Not a pass. */
  readonly missingModelTimesS: readonly number[];
  /** Quantities in the model Result that have no CSV column, as "entity: quantity". Not a pass. */
  readonly missingReference: readonly string[];
  readonly pointsChecked: number;
}

type Allowed = (ref: number) => number;

const riseAllowed: Allowed = (ref) => Math.max(RISE_REL_TOL * Math.abs(ref), RISE_ABS_TOL_K); // Req 13.5
const heightAllowed: Allowed = () => INTERFACE_HEIGHT_ABS_TOL_M; // Req 13.5
const flowAllowed: Allowed = (ref) => Math.max(VENT_FLOW_REL_TOL * Math.abs(ref), VENT_FLOW_ABS_TOL_KG_S); // Req 13.5

/** Model Rise: temperature minus its first sample (t = 0), K. Same definition as the CSV reader (Req 13.1). */
function riseOf(tempK: Float64Array): Float64Array {
  const out = new Float64Array(tempK.length);
  const t0 = tempK.length > 0 ? (tempK[0] as number) : Number.NaN;
  for (let i = 0; i < out.length; i++) out[i] = (tempK[i] as number) - t0;
  return out;
}

/** Index of the sample at `timeS`, or -1. `timesS` is ascending. */
export function findSampleIndex(timesS: Float64Array, timeS: number): number {
  let lo = 0;
  let hi = timesS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = timesS[mid] as number;
    if (Math.abs(t - timeS) <= TIME_MATCH_S) return mid;
    if (t < timeS) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface Series {
  readonly quantity: string;
  readonly entity: string;
  readonly allowed: Allowed;
  readonly cfast: Float64Array | undefined;
  readonly cfastTimesS: Float64Array;
  readonly model: Float64Array;
}

const LAYER_FLOWS: readonly { q: VentQuantity; label: string; pick: (e: VentEndSeries) => Float64Array }[] = [
  { q: 'inflowUpper', label: 'upper inflow', pick: (e) => e.upperInKgS },
  { q: 'outflowUpper', label: 'upper outflow', pick: (e) => e.upperOutKgS },
  { q: 'inflowLower', label: 'lower inflow', pick: (e) => e.lowerInKgS },
  { q: 'outflowLower', label: 'lower outflow', pick: (e) => e.lowerOutKgS },
];

function compartmentSeries(c: CompartmentSeries, csvTable: ReferenceTable): Series[] {
  const rise = (layer: 'upper' | 'lower', tempK: Float64Array): Series => ({
    quantity: `${layer} layer Rise (K)`,
    entity: c.id,
    allowed: riseAllowed,
    cfast: findColumn(csvTable, { entity: c.id, quantity: 'tempRiseK', layer })?.values,
    cfastTimesS: csvTable.timesS,
    model: riseOf(tempK),
  });
  return [
    rise('upper', c.upperTempK),
    rise('lower', c.lowerTempK),
    {
      quantity: 'interface height (m)',
      entity: c.id,
      allowed: heightAllowed,
      cfast: findColumn(csvTable, { entity: c.id, quantity: 'layerHeightM' })?.values,
      cfastTimesS: csvTable.timesS,
      model: c.interfaceHeightM,
    },
  ];
}

/**
 * Compares a model Result with CFAST reference tables (Req 13.4 to 13.6).
 * `compartments` and `vents` are the parsed `*_compartments.csv` and `*_vents.csv`; they share one time axis.
 */
export function compareWithReference(result: Result, compartments: ReferenceTable, vents: ReferenceTable): CaseComparison {
  const series: Series[] = [];
  for (const c of result.compartments) series.push(...compartmentSeries(c, compartments));
  for (const v of result.vents) {
    const end = v.ends[0];
    for (const f of LAYER_FLOWS) {
      series.push({
        quantity: `vent flow, ${f.label} (kg/s)`,
        entity: v.id,
        allowed: flowAllowed,
        cfast: findColumn(vents, { entity: v.id, quantity: f.q })?.values,
        cfastTimesS: vents.timesS,
        model: f.pick(end),
      });
    }
  }

  const failures: CheckFailure[] = [];
  const summaries: QuantitySummary[] = [];
  const missingReference: string[] = [];
  const missingTimes = new Set<number>();
  let pointsChecked = 0;

  for (const s of series) {
    if (!s.cfast) {
      missingReference.push(`${s.entity}: ${s.quantity}`);
      continue;
    }
    const timesS = s.cfastTimesS;
    let checked = 0;
    let nFail = 0;
    let worst: { ratio: number; t: number; ref: number; mod: number } | undefined;
    for (let r = 0; r < timesS.length; r++) {
      const t = timesS[r] as number;
      if (!(t >= COMPARE_START_TIME_S)) continue; // Req 13.4
      const i = findSampleIndex(result.timesS, t);
      if (i < 0) {
        missingTimes.add(t);
        continue;
      }
      const ref = s.cfast[r] as number;
      const mod = s.model[i] as number;
      const diff = mod - ref;
      const allowed = s.allowed(ref);
      // NaN on either side is a failure, never a pass.
      const ok = Math.abs(diff) <= allowed;
      const ratio = Number.isNaN(diff) ? Number.POSITIVE_INFINITY : Math.abs(diff) / allowed;
      checked++;
      if (!ok) {
        nFail++;
        failures.push({ quantity: s.quantity, entity: s.entity, timeS: t, cfastValue: ref, modelValue: mod, difference: diff });
      }
      if (!worst || ratio > worst.ratio) worst = { ratio, t, ref, mod };
    }
    pointsChecked += checked;
    summaries.push({
      quantity: s.quantity,
      entity: s.entity,
      pointsChecked: checked,
      failures: nFail,
      worstRatio: worst?.ratio ?? 0,
      worstTimeS: worst?.t ?? Number.NaN,
      worstCfastValue: worst?.ref ?? Number.NaN,
      worstModelValue: worst?.mod ?? Number.NaN,
    });
  }

  const missingModelTimesS = [...missingTimes].sort((a, b) => a - b);
  return {
    passed: failures.length === 0 && missingModelTimesS.length === 0 && missingReference.length === 0 && pointsChecked > 0,
    failures,
    summaries,
    missingModelTimesS,
    missingReference,
    pointsChecked,
  };
}

export interface RunDifference {
  /** False when the two runs agree bit for bit on every compared quantity: report "no difference". */
  readonly differs: boolean;
  readonly largestAbsDifference: number;
  readonly timeS: number;
  /** For example "upper layer Rise (K)"; empty when `differs` is false. */
  readonly quantity: string;
  readonly entity: string;
  /** Model values of the CFAST-order run and the intended-order run at that point. */
  readonly cfastOrderValue: number;
  readonly intendedOrderValue: number;
}

const NO_DIFFERENCE: RunDifference = {
  differs: false,
  largestAbsDifference: 0,
  timeS: Number.NaN,
  quantity: '',
  entity: '',
  cfastOrderValue: Number.NaN,
  intendedOrderValue: Number.NaN,
};

/**
 * Difference between the CFAST-order run and the intended-order run of the same case (Req 6.13): largest
 * absolute difference over upper and lower layer Rise, interface height and vent layer flows at every time
 * of 60 s or later. Never changes a verdict.
 */
export function compareRuns(cfastOrder: Result, intendedOrder: Result): RunDifference {
  let best: RunDifference = NO_DIFFERENCE;
  const consider = (quantity: string, entity: string, a: Float64Array, b: Float64Array): void => {
    for (let i = 0; i < cfastOrder.timesS.length; i++) {
      const t = cfastOrder.timesS[i] as number;
      if (!(t >= COMPARE_START_TIME_S)) continue; // Req 13.4
      const j = findSampleIndex(intendedOrder.timesS, t);
      if (j < 0) continue;
      const x = a[i] as number;
      const y = b[j] as number;
      if (Object.is(x, y)) continue;
      const d = Math.abs(x - y);
      if (Number.isNaN(d)) {
        // A NaN in only one run is a difference; report it as the largest.
        best = { differs: true, largestAbsDifference: Number.POSITIVE_INFINITY, timeS: t, quantity, entity, cfastOrderValue: x, intendedOrderValue: y };
      } else if (d > best.largestAbsDifference && best.largestAbsDifference !== Number.POSITIVE_INFINITY) {
        best = { differs: true, largestAbsDifference: d, timeS: t, quantity, entity, cfastOrderValue: x, intendedOrderValue: y };
      }
    }
  };

  for (const a of cfastOrder.compartments) {
    const b = intendedOrder.compartments.find((c) => c.id === a.id);
    if (!b) continue;
    consider('upper layer Rise (K)', a.id, riseOf(a.upperTempK), riseOf(b.upperTempK));
    consider('lower layer Rise (K)', a.id, riseOf(a.lowerTempK), riseOf(b.lowerTempK));
    consider('interface height (m)', a.id, a.interfaceHeightM, b.interfaceHeightM);
  }
  for (const a of cfastOrder.vents) {
    const b = intendedOrder.vents.find((v) => v.id === a.id);
    if (!b) continue;
    for (const f of LAYER_FLOWS) consider(`vent flow, ${f.label} (kg/s)`, a.id, f.pick(a.ends[0]), f.pick(b.ends[0]));
  }
  return best;
}
