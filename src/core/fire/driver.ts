// Time loop of a run (design.md, Run lifecycle, Solver design "Events", "Failure detection"; Requirements 4.6, 9.6, 9.8,
// 10.2 to 10.9, 11.5, 11.6). The driver owns the event list, the samples, the species update after each accepted step,
// progress events and every failure path. It never throws: any exception becomes a failed Result with INTERNAL_ERROR.
import {
  DY_O2_MAX,
  EVENT_SNAP_S,
  FINAL_SAMPLE_TOL_S,
  H_INITIAL,
  PROGRESS_SIM_INTERVAL_S,
  PROGRESS_WALL_INTERVAL_MS,
} from "./constants";
import type { Model } from "./model";
import {
  collectSpeciesFlows,
  commitWalls,
  createResidual,
  createWorkspace,
  evaluateModel,
  type Workspace,
} from "./residual";
import { emptyStats, createRecorder, emptyResult, finishResult, recordSample, type Recorder } from "./result";
import { ImplicitSolver } from "./solver/stepControl";
import {
  LAYER_LOWER,
  LAYER_UPPER,
  SPECIES_COUNT,
  SPECIES_O2,
  layerNode,
  massFraction,
  updateSpecies,
} from "./species/tracker";
import { VARS_PER_COMPARTMENT, initialState, projectUpperVolumes } from "./state";
import type { Result, ResultFlag, ResultStats, RunOptions, Warning } from "./types";
import { breakpoints } from "./vents/openFraction";
import { internalError, nonFiniteState, solverStepTooSmall, speciesOutOfRange } from "./validate/warnings";

const VARIABLE_NAMES = [
  "pressure",
  "upper layer volume",
  "upper layer temperature",
  "lower layer temperature",
  "ceiling surface temperature",
  "upper wall surface temperature",
  "lower wall surface temperature",
  "floor surface temperature",
] as const;

// One time at which the driver stops: a sample, a kink of an input table (restart), or both.
interface RunEvent {
  timeS: number;
  restart: boolean; // discard the BDF history and restart with BDF1 (Requirement 4.6)
  sampleIndex: number; // -1 when no sample is taken here
}

/** Requirement 10.2: t = k * printInterval for every k up to floor(duration / printInterval), plus the duration if it is not a multiple. */
export function sampleTimes(durationS: number, printIntervalS: number): number[] {
  let kMax = Math.floor(durationS / printIntervalS);
  while (kMax > 0 && kMax * printIntervalS > durationS) kMax--;
  const times: number[] = [];
  for (let k = 0; k <= kMax; k++) times.push(k * printIntervalS); // k * h, not repeated addition: bit-reproducible
  if (durationS - kMax * printIntervalS > FINAL_SAMPLE_TOL_S) times.push(durationS);
  return times;
}

// Design Solver design, "Events": table times where the slope of an input changes, as restart events, and the sample
// times as pure sample events. Sorted, one entry per distinct time.
function buildEvents(model: Model, samples: readonly number[], durationS: number): RunEvent[] {
  const byTime = new Map<number, RunEvent>();
  const add = (timeS: number, restart: boolean, sampleIndex: number): void => {
    if (!(timeS > 0) || !(timeS <= durationS)) return;
    const existing = byTime.get(timeS);
    if (existing === undefined) {
      byTime.set(timeS, { timeS, restart, sampleIndex });
    } else {
      if (restart) existing.restart = true;
      if (sampleIndex >= 0) existing.sampleIndex = sampleIndex;
    }
  };
  samples.forEach((t, k) => add(t, false, k));
  add(durationS, false, -1);
  for (const v of model.vents) {
    if (v.kind === "leakage") continue;
    for (const t of breakpoints(v.open)) add(t, true, -1); // Requirement 4.6
  }
  for (const fm of model.fires) {
    const ignition = fm.fire.ignitionTimeS ?? 0;
    add(ignition, true, -1);
    for (const row of fm.fire.table) add(ignition + row.timeS, true, -1); // piecewise-linear HRR table kinks
  }
  if (model.adiabatic && model.fires.length > 0) add(1, true, -1); // CFAST adiabatic 1 s ramp (design Fire modules step 4)
  return [...byTime.values()].sort((a, b) => a.timeS - b.timeS);
}

function findNonFiniteState(model: Model, y: Float64Array): { quantity: string; compartmentId: string } | null {
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) {
      const c = model.compartments[Math.floor(i / VARS_PER_COMPARTMENT)];
      return { quantity: VARIABLE_NAMES[i % VARS_PER_COMPARTMENT] ?? "state", compartmentId: c?.id ?? "" };
    }
  }
  return null;
}

// Requirement 11.5: derived quantities of the evaluation at the accepted state.
function findNonFiniteDerived(model: Model, ws: Workspace): { quantity: string; compartmentId: string | null } | null {
  for (const fm of model.fires) {
    const ev = ws.fireEvals[fm.index];
    if (ev !== undefined && !(Number.isFinite(ev.hrrW) && Number.isFinite(ev.entrainmentKgS))) {
      return { quantity: `burned heat release rate of fire "${fm.fire.id}"`, compartmentId: model.compartments[fm.compartment]?.id ?? null };
    }
  }
  for (let vi = 0; vi < model.vents.length; vi++) {
    const r = ws.ventResults[vi];
    if (r === null || r === undefined) continue;
    for (const t of r.transfers) {
      if (!Number.isFinite(t.massKgS) || !Number.isFinite(t.sourceTempK)) {
        const v = model.vents[vi];
        const first = v === undefined ? undefined : model.compartments[v.ends[0]];
        return { quantity: `mass flow of vent "${v?.id ?? ""}"`, compartmentId: first?.id ?? null };
      }
    }
  }
  return null;
}

function upperBurnW(model: Model, ws: Workspace): number {
  let sum = 0;
  for (const fm of model.fires) sum += ws.fireEvals[fm.index]?.hrrUpperW ?? 0;
  return Number.isFinite(sum) ? sum : 0;
}

// Design Solver design, "Additional step limits": the largest change of the oxygen fraction of a fire room per step is
// bounded by DY_O2_MAX. The rate comes from the last accepted step, so the limit follows the fire.
function o2Fractions(model: Model, ws: Workspace, out: Float64Array): void {
  for (let i = 0; i < model.compartments.length; i++) {
    out[2 * i] = massFraction(ws.species, layerNode(i, LAYER_LOWER), SPECIES_O2);
    out[2 * i + 1] = massFraction(ws.species, layerNode(i, LAYER_UPPER), SPECIES_O2);
  }
}

/**
 * Runs a built model to the end of the Scenario. `warnings` and `flags` come from the Input_Validator and are kept in
 * front of any run-time warning, so flag indices stay valid. Never throws.
 */
export function runModel(model: Model, warnings: Warning[], flags: ResultFlag[], options: RunOptions): Result {
  let recorder: Recorder | null = null;
  const stats: ResultStats = emptyStats();
  const stepSizes: number[] = [];
  try {
    const scenario = model.scenario;
    const durationS = scenario.durationS;
    const times = sampleTimes(durationS, scenario.printIntervalS);
    const events = buildEvents(model, times, durationS);
    const rec = createRecorder(model, times.length);
    recorder = rec;
    const ws = createWorkspace(model);
    const solver = new ImplicitSolver({
      residual: createResidual(model, ws),
      sparsity: model.sparsity,
      atol: model.atol,
      deltaMin: model.deltaMin,
      differential: model.differential,
      ...(options.numerical?.rtol !== undefined ? { params: { rtol: options.numerical.rtol } } : {}),
    });
    const y0 = initialState(model);
    const nodes = 2 * model.compartments.length;
    const o2Before = new Float64Array(nodes);
    const o2After = new Float64Array(nodes);

    const finish = (status: "ok" | "failed", extra?: Warning): Result => {
      if (extra !== undefined) warnings.push(extra);
      stats.steps = solver.stats.steps;
      stats.rejected = solver.stats.rejected;
      stats.newtonIterations = solver.stats.newtonIterations;
      stats.jacobians = solver.stats.jacobians;
      if (options.recordSteps === true) stats.stepSizesS = Float64Array.from(stepSizes);
      return finishResult(rec, status, warnings, flags, stats);
    };

    // Progress (Requirement 10.5, 10.6). Simulated-time marks are landed on exactly; the wall-clock rule uses `now`.
    const now = options.now;
    const progress = options.onProgress;
    let lastWall = now !== undefined ? now() : 0;
    let lastFraction = 0;
    const emit = (simTimeS: number, fraction: number): void => {
      lastFraction = Math.min(1, Math.max(lastFraction, fraction));
      if (now !== undefined) lastWall = now();
      if (progress !== undefined) progress({ simTimeS, fraction: lastFraction });
    };

    // t = 0: evaluate once to fill the first sample (Requirement 3.5, 8.2, 8.9), then start the solver.
    evaluateModel(model, ws, 0, y0);
    const bad0 = findNonFiniteState(model, y0) ?? findNonFiniteDerived(model, ws);
    if (bad0 !== null) return finish("failed", nonFiniteState(bad0.quantity, bad0.compartmentId, 0));
    recordSample(rec, model, ws, y0, times[0] ?? 0);
    emit(0, 0);
    solver.restart(0, y0);

    let nextMarkS = PROGRESS_SIM_INTERVAL_S;
    let ei = 0;
    let o2Cap = Infinity;
    const stepCapS = model.maxTimeStepS !== undefined && model.maxTimeStepS > 0 ? model.maxTimeStepS : Infinity;

    while (ei < events.length) {
      const ev = events[ei] as RunEvent;
      const targetS = Math.min(ev.timeS, nextMarkS < durationS ? nextMarkS : Infinity);

      while (targetS - solver.t > EVENT_SNAP_S) {
        o2Fractions(model, ws, o2Before);
        const tOld = solver.t;
        const res = solver.advance(targetS, Math.min(stepCapS, o2Cap));
        if (!res.ok) return finish("failed", solverStepTooSmall(res.t)); // Requirement 9.6
        const tNew = solver.t;
        const y = solver.y;
        const bad = findNonFiniteState(model, y);
        if (bad !== null) return finish("failed", nonFiniteState(bad.quantity, bad.compartmentId, tNew)); // Requirement 11.5

        // Requirement 3.6: project Vu into [VMIN, VMAX]; the solver history holds the same array, so it sees the value.
        projectUpperVolumes(model, y);
        evaluateModel(model, ws, tNew, y);
        const badD = findNonFiniteDerived(model, ws);
        if (badD !== null) return finish("failed", nonFiniteState(badD.quantity, badD.compartmentId, tNew));

        // Species update with the flows of the accepted state (design Species_Tracker). Shafts keep one composition.
        const hS = tNew - tOld;
        const upd = updateSpecies(ws.species, collectSpeciesFlows(ws), hS);
        if (!upd.ok) {
          const f = upd.failure;
          const c = model.compartments[Math.floor(f.node / 2)];
          if (Number.isNaN(f.fraction)) return finish("failed", nonFiniteState(`${f.species} mass fraction`, c?.id ?? null, tNew));
          return finish(
            "failed",
            speciesOutOfRange(c?.id ?? "", f.node % 2 === LAYER_LOWER ? "lower" : "upper", f.species, tNew), // Requirement 8.8
          );
        }
        copyShaftSpecies(model, ws);
        commitWalls(model, ws, tNew, y); // Tech Ref 5.4: the trial wall profile becomes the current one

        if (options.recordSteps === true) stepSizes.push(res.h);
        stats.maxUpperBurnHrrW = Math.max(stats.maxUpperBurnHrrW, upperBurnW(model, ws));

        o2Fractions(model, ws, o2After);
        o2Cap = o2StepCap(model, o2Before, o2After, hS);

        // Wall-clock rule of Requirement 10.5.
        if (now !== undefined && now() - lastWall >= PROGRESS_WALL_INTERVAL_MS) emit(tNew, tNew / durationS);
      }

      // Reached the target (within the snap distance).
      if (nextMarkS < durationS && nextMarkS - solver.t <= EVENT_SNAP_S) {
        emit(nextMarkS, nextMarkS / durationS);
        nextMarkS += PROGRESS_SIM_INTERVAL_S;
      }
      if (ev.timeS - solver.t <= EVENT_SNAP_S) {
        let restart = false;
        // Merge every event that lies within the snap distance of the accepted time.
        while (ei < events.length && (events[ei] as RunEvent).timeS - solver.t <= EVENT_SNAP_S) {
          const e = events[ei] as RunEvent;
          if (e.sampleIndex >= 0) recordSample(rec, model, ws, solver.y, times[e.sampleIndex] as number); // Requirement 10.4
          if (e.restart) restart = true;
          ei++;
        }
        if (restart && ei < events.length) solver.restart(solver.t, solver.y.slice()); // Requirement 4.6
      }
    }

    emit(durationS, 1); // Requirement 10.6
    return finish("ok");
  } catch (e) {
    // Requirement 11.6: never throw to the caller.
    const detail = e instanceof Error ? e.message : String(e);
    warnings.push(internalError(detail));
    if (recorder === null) return emptyResult("failed", warnings, flags);
    if (options.recordSteps === true) stats.stepSizesS = Float64Array.from(stepSizes);
    return finishResult(recorder, "failed", warnings, flags, stats);
  }
}

// CFAST 7.7.7 source, solve.f90: a shaft is one zone, so the lower layer species fractions are copied from the upper layer.
function copyShaftSpecies(model: Model, ws: Workspace): void {
  for (const c of model.compartments) {
    if (!c.isShaft) continue;
    const up = layerNode(c.index, LAYER_UPPER);
    const lo = layerNode(c.index, LAYER_LOWER);
    const mUp = ws.species.massKg[up] as number;
    const mLo = ws.species.massKg[lo] as number;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const frac = mUp > 0 ? (ws.species.speciesKg[up * SPECIES_COUNT + s] as number) / mUp : 0;
      ws.species.speciesKg[lo * SPECIES_COUNT + s] = frac * mLo;
    }
  }
}

// Largest step that keeps the change of the oxygen fraction of the fire rooms at about DY_O2_MAX, from the last step's rate.
function o2StepCap(model: Model, before: Float64Array, after: Float64Array, hS: number): number {
  if (!(hS > 0)) return Infinity;
  let maxRate = 0;
  for (const c of model.compartments) {
    if (c.fires.length === 0) continue;
    for (const k of [2 * c.index, 2 * c.index + 1]) {
      maxRate = Math.max(maxRate, Math.abs((after[k] as number) - (before[k] as number)) / hS);
    }
  }
  return maxRate > 0 ? Math.max(DY_O2_MAX / maxRate, H_INITIAL) : Infinity;
}
