// Two-zone compartment fire model, re-implemented from NIST CFAST 7.7.7 (spec fire-zone). Public API.
// This is a reference simulation. It makes no statement that any building is acceptable.
// Requirements 1.11, 10.8, 11.6: a Result for every Scenario object; a TypeError only when the argument is not an object.
import { runModel } from "./driver";
import { buildModel, type Model } from "./model";
import { emptyResult } from "./result";
import { internalError } from "./validate/warnings";
import { validate, type ValidationResult } from "./validate/validate";
import type { Result, RunOptions, Scenario, Warning } from "./types";

export type {
  Ambient,
  CeilingFloorVent,
  Compartment,
  CompartmentSeries,
  CompartmentKind,
  Fire,
  HrrRow,
  LayerSeries,
  LeakageVent,
  OpenFractionTable,
  ProgressEvent,
  Result,
  ResultFlag,
  ResultStats,
  ResultStatus,
  RunOptions,
  Scenario,
  ScenarioOptions,
  Surface,
  SurfaceLayer,
  UnsupportedItem,
  Vent,
  VentEndSeries,
  VentSeries,
  Warning,
  WallVent,
} from "./types";

/** Input_Validator only (Requirement 1). Throws a TypeError when `scenario` is not an object. */
export function validateScenario(scenario: Scenario): Warning[] {
  return validate(scenario).warnings;
}

/**
 * Runs the fire model (design.md, Run lifecycle).
 * Returns status "invalid" with one Warning per failed check when the Scenario is rejected, "failed" with the samples
 * taken so far when the run stops, and "ok" otherwise. Throws a TypeError only when `scenario` is not an object.
 */
export function runFire(scenario: Scenario, options: RunOptions = {}): Result {
  let checked: ValidationResult;
  try {
    checked = validate(scenario);
  } catch (e) {
    if (e instanceof TypeError && (typeof scenario !== "object" || scenario === null)) throw e;
    if (e instanceof TypeError && Array.isArray(scenario)) throw e;
    return emptyResult("failed", [internalError(e instanceof Error ? e.message : String(e))], []);
  }
  if (!checked.valid) return emptyResult("invalid", checked.warnings, checked.flags); // Requirements 1.4 to 1.10, 10.3
  let model: Model;
  try {
    model = buildModel(checked.scenario);
  } catch (e) {
    const w = internalError(e instanceof Error ? e.message : String(e));
    return emptyResult("failed", [...checked.warnings, w], checked.flags);
  }
  return runModel(model, [...checked.warnings], checked.flags, options);
}
