// CFAST 7.7.7 input reader (Req 15.1 to 15.4). Text in, Scenario out. Pure string-to-object code: no file access,
// no evaluation of the text, no dependencies. File reading stays in validation/harness/.
import type { Scenario } from "../types";
import * as W from "../validate/warnings";
import type { Warning } from "../validate/warnings";
import { newIssues, readGroups } from "./namelist";
import type { UnsupportedReason } from "./namelist";
import { toScenario } from "./toScenario";
import { tokenize } from "./tokenize";

export type { UnsupportedCode, UnsupportedReason } from "./namelist";
export { ambientSpecies, saturationMassFactor, saturationPressurePa } from "./humidity";

export interface CfastInputResult {
  /** Null when the text is too large or has no &COMP group. The Scenario is not validated; run `validate` on it. */
  scenario: Scenario | null;
  /** Every Warning has a line number in `location.field` ("line N"), from 1 to the number of lines of the input. */
  warnings: Warning[];
  /** Reasons the case cannot be reproduced. Non-empty means the Validation_Suite reports "unsupported" (Req 15.3). */
  unsupported: UnsupportedReason[];
}

/**
 * Convert CFAST input text into a Scenario. Never throws on any string and never evaluates the text (Req 15.4).
 * Throws TypeError only when `text` is not a string (a programmer error).
 */
export function parseCfastInput(text: string): CfastInputResult {
  if (typeof text !== "string") throw new TypeError("parseCfastInput: the input must be a string");
  const issues = newIssues();
  try {
    const t = tokenize(text);
    issues.warnings.push(...t.warnings);
    if (t.limitHit) {
      issues.unsupported.push({ code: "INPUT_LIMIT", detail: "the input is larger than the reader limits", line: 1 });
    }
    if (text.length > 0 && t.groups.length === 0 && !t.limitHit && t.warnings.length === 0) {
      issues.warnings.push(W.cfastParse(1, "no namelist group (&NAME ... /) was found"));
    }
    const groups = readGroups(t.groups, issues);
    const scenario = t.limitHit && t.groups.length === 0 ? null : toScenario(groups, issues);
    return { scenario, warnings: issues.warnings, unsupported: issues.unsupported };
  } catch (e) {
    // Defensive: the reader is written to be total, so this only guards against a bug.
    const detail = e instanceof Error ? e.message : "unknown error";
    issues.warnings.push(W.cfastParse(1, `the input could not be read (${detail})`));
    issues.unsupported.push({ code: "INVALID_INPUT", detail: "internal reader error", line: 1 });
    return { scenario: null, warnings: issues.warnings, unsupported: issues.unsupported };
  }
}
