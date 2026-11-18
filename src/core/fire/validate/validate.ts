// Input_Validator (design: Input_Validator). Runs every check, collects all failures (Req 1.10).
// Throws only for a non-object argument (Req 1.11).
import type { ResultFlag, Scenario } from "../types";
import {
  checkAmbient,
  checkCompartments,
  checkCounts,
  checkFires,
  checkFiniteNumbers,
  checkHeatOfCombustion,
  checkOutput,
  checkStacking,
  checkUnsupported,
  checkVents,
  isRec,
  stairShaftTargets,
} from "./checks";
import { stairOrShaftLimit } from "./warnings";
import type { Warning } from "./warnings";

export interface ValidationResult {
  /** False when any warning has severity "error". The run must not start (Req 1.4 to 1.10). */
  valid: boolean;
  /** Error warnings first in check order, then soft warnings. */
  warnings: Warning[];
  /** Stair, shaft and corridor flags; `warningIndex` points into `warnings` (Req 5.7, 5.8). */
  flags: ResultFlag[];
  /** Copy of the input without the `unsupported` list: those items are dropped (Req 5.9, 6.12). */
  scenario: Scenario;
}

export function validate(scenario: unknown): ValidationResult {
  if (!isRec(scenario)) {
    throw new TypeError("validate: the scenario must be an object");
  }
  const errors: Warning[] = [
    ...checkCounts(scenario),
    ...checkFiniteNumbers(scenario),
    ...checkCompartments(scenario),
    ...checkAmbient(scenario),
    ...checkVents(scenario),
    ...checkFires(scenario),
    ...checkOutput(scenario),
  ];
  const soft: Warning[] = [
    ...checkStacking(scenario),
    ...checkUnsupported(scenario),
    ...checkHeatOfCombustion(scenario),
  ];
  const warnings = [...errors, ...soft];
  const flags: ResultFlag[] = [];
  for (const target of stairShaftTargets(scenario)) {
    flags.push({ warningIndex: warnings.length, target, quantities: "all" });
    warnings.push(stairOrShaftLimit(target));
  }
  const { unsupported: _dropped, ...rest } = scenario as Record<string, unknown>;
  return {
    valid: !warnings.some((w) => w.severity === "error"),
    warnings,
    flags,
    scenario: rest as unknown as Scenario,
  };
}
