// CFAST namelist keyword tables and typing (Req 15.1 to 15.3). Raw groups from tokenize.ts become typed groups.
// Keywords and units follow the CFAST 7.7.7 User's Guide (keyword appendix) and input_namelist.f90.
// The unit column is documentation of the input unit; the conversion to SI lives in toScenario.ts only.
import * as W from "../validate/warnings";
import type { Warning } from "../validate/warnings";
import type { RawGroup, RawValue } from "./tokenize";

export type UnsupportedCode =
  | "MECHANICAL_VENT"
  | "CROSS_SECTION"
  | "UNKNOWN_KEYWORD"
  | "UNSUPPORTED_GROUP"
  | "UNSUPPORTED_VALUE"
  | "INVALID_INPUT"
  | "INPUT_LIMIT";

/** Why a CFAST case cannot be reproduced by this model. The Validation_Suite reports such a case as "unsupported". */
export interface UnsupportedReason {
  code: UnsupportedCode;
  detail: string;
  line: number; // 1-based
}

/** Collects Warnings and unsupported reasons while a file is read. */
export interface Issues {
  warnings: Warning[];
  unsupported: UnsupportedReason[];
}

export function newIssues(): Issues {
  return { warnings: [], unsupported: [] };
}

/** A problem that does not change the physics (a default was used, a keyword was ignored). Warning only. */
export function note(issues: Issues, line: number, detail: string): void {
  issues.warnings.push(W.cfastParse(line, detail));
}

/** Input that could not be read; the item is dropped, so the case is `unsupported`. */
export function invalid(issues: Issues, line: number, detail: string): void {
  issues.warnings.push(W.cfastParse(line, detail));
  issues.unsupported.push({ code: "INVALID_INPUT", detail, line });
}

/** A CFAST feature this model does not have. Warning plus unsupported reason. */
export function unsupportedFeature(issues: Issues, code: UnsupportedCode, feature: string, line: number): void {
  issues.warnings.push(W.cfastUnsupported(feature, line));
  issues.unsupported.push({ code, detail: feature, line });
}

export type KeyType = "number" | "string" | "boolean";
export interface KeySpec {
  type: KeyType;
  list: boolean;
  unit: string; // input unit, "" when the value has none
  /** Known to CFAST but not modelled here: reading it marks the case unsupported. */
  unsupported?: { code: UnsupportedCode; reason: string };
}

const num = (unit = ""): KeySpec => ({ type: "number", list: false, unit });
const nums = (unit = ""): KeySpec => ({ type: "number", list: true, unit });
const str = (): KeySpec => ({ type: "string", list: false, unit: "" });
const strs = (): KeySpec => ({ type: "string", list: true, unit: "" });
const bool = (): KeySpec => ({ type: "boolean", list: false, unit: "" });
const notModelled = (spec: KeySpec, code: UnsupportedCode, reason: string): KeySpec => ({
  ...spec,
  unsupported: { code, reason },
});

// Groups the reader maps (Req 15.1). `&TAIL` has no keywords.
export const KEYWORD_TABLES: Readonly<Record<string, Readonly<Record<string, KeySpec>>>> = {
  HEAD: { VERSION: num(), TITLE: str() },
  TIME: { SIMULATION: num("s"), PRINT: num("s"), SMOKEVIEW: num("s"), SPREADSHEET: num("s") },
  INIT: {
    PRESSURE: num("Pa"),
    RELATIVE_HUMIDITY: num("%"),
    INTERIOR_TEMPERATURE: num("C"),
    EXTERIOR_TEMPERATURE: num("C"),
  },
  MISC: { ADIABATIC: bool(), MAX_TIME_STEP: num("s") },
  MATL: {
    ID: str(),
    MATERIAL: str(),
    FYI: str(),
    CONDUCTIVITY: num("W/(m K)"), // the User's Guide table says kW; the source and the data use W (design, CFAST input unit table)
    DENSITY: num("kg/m3"),
    SPECIFIC_HEAT: num("kJ/(kg K)"),
    THICKNESS: num("m"),
    EMISSIVITY: num(),
  },
  COMP: {
    ID: str(),
    FYI: str(),
    WIDTH: num("m"),
    DEPTH: num("m"),
    HEIGHT: num("m"),
    ORIGIN: nums("m"),
    GRID: nums(), // CFAST wall-grid hint, no effect here
    CEILING_MATL_ID: strs(),
    WALL_MATL_ID: strs(),
    FLOOR_MATL_ID: strs(),
    CEILING_THICKNESS: nums("m"),
    WALL_THICKNESS: nums("m"),
    FLOOR_THICKNESS: nums("m"),
    SHAFT: bool(),
    HALL: bool(),
    LEAK_AREA_RATIO: nums(),
    LEAK_AREA: nums("m2"), // accepted and ignored, as CFAST ignores it
    FLOW_COEFFICIENT: num(), // CFAST overwrites it for leakage vents
    CROSS_SECT_AREAS: notModelled(nums("m2"), "CROSS_SECTION", "a variable cross-section compartment"),
    CROSS_SECT_HEIGHTS: notModelled(nums("m"), "CROSS_SECTION", "a variable cross-section compartment"),
  },
  VENT: {
    ID: str(),
    FYI: str(),
    TYPE: str(),
    COMP_IDS: strs(),
    BOTTOM: num("m"),
    HEIGHT: num("m"),
    TOP: num("m"),
    WIDTH: num("m"),
    OFFSET: num("m"),
    OFFSETS: nums("m"),
    AREA: num("m2"),
    SHAPE: str(),
    FACE: str(),
    CRITERION: str(),
    T: nums("s"),
    F: nums(),
    FLOW_COEFFICIENT: num(), // not used by the model
  },
  FIRE: {
    ID: str(),
    FYI: str(),
    COMP_ID: str(),
    FIRE_ID: str(),
    LOCATION: nums("m"),
    IGNITION_CRITERION: str(),
    SETPOINT: num("s"), // seconds when IGNITION_CRITERION is TIME
  },
  CHEM: {
    ID: str(),
    CARBON: num(),
    HYDROGEN: num(),
    OXYGEN: num(),
    NITROGEN: num(),
    CHLORINE: num(),
    HEAT_OF_COMBUSTION: num("kJ/kg"),
    RADIATIVE_FRACTION: num(),
  },
  TABL: { ID: str(), LABELS: strs(), DATA: nums() },
  TAIL: {},
};

/** Groups CFAST has that the model does not use. They are skipped with a Warning (Req 15.2). */
const SKIPPED_GROUP_NOTE: Readonly<Record<string, string>> = {
  DEVC: "devices and targets",
  SLCF: "visualisation slices",
  DIAG: "diagnostics",
};

export interface TypedValue {
  line: number;
  values: RawValue[]; // already checked against the keyword type
}
export interface Group {
  name: string;
  line: number;
  keys: Map<string, TypedValue>;
}

export const numOf = (g: Group, key: string): number | undefined => {
  const v = g.keys.get(key)?.values[0];
  return typeof v === "number" ? v : undefined;
};
export const numsOf = (g: Group, key: string): number[] | undefined => {
  const v = g.keys.get(key);
  return v === undefined ? undefined : v.values.filter((x): x is number => typeof x === "number");
};
export const strOf = (g: Group, key: string): string | undefined => {
  const v = g.keys.get(key)?.values[0];
  return typeof v === "string" ? v : undefined;
};
export const strsOf = (g: Group, key: string): string[] | undefined => {
  const v = g.keys.get(key);
  return v === undefined ? undefined : v.values.filter((x): x is string => typeof x === "string");
};
export const boolOf = (g: Group, key: string): boolean | undefined => {
  const v = g.keys.get(key)?.values[0];
  return typeof v === "boolean" ? v : undefined;
};
export const lineOf = (g: Group, key: string): number => g.keys.get(key)?.line ?? g.line;

function coerce(type: KeyType, values: RawValue[]): RawValue[] | null {
  const out: RawValue[] = [];
  for (const v of values) {
    if (type === "number" && typeof v === "number") out.push(v);
    else if (type === "string" && typeof v === "string") out.push(v);
    else if (type === "boolean") {
      if (typeof v === "boolean") out.push(v);
      else if (typeof v === "string" && /^(t|true)$/i.test(v)) out.push(true);
      else if (typeof v === "string" && /^(f|false)$/i.test(v)) out.push(false);
      else return null;
    } else return null;
  }
  return out;
}

/** Type the keywords of each raw group. Unknown groups are skipped, unknown keywords mark the case unsupported. */
export function readGroups(raw: RawGroup[], issues: Issues): Group[] {
  const groups: Group[] = [];
  const skipped = new Map<string, { line: number; count: number }>();
  for (const rg of raw) {
    const table = KEYWORD_TABLES[rg.name];
    if (table === undefined) {
      if (rg.name === "CONN") {
        // Merged walls (surface connections between compartments) are not in v1, so the case differs from CFAST.
        unsupportedFeature(
          issues,
          "UNSUPPORTED_GROUP",
          "the group &CONN (heat conduction between compartment surfaces)",
          rg.line,
        );
        continue;
      }
      const seen = skipped.get(rg.name);
      if (seen === undefined) skipped.set(rg.name, { line: rg.line, count: 1 });
      else seen.count += 1;
      continue;
    }
    const keys = new Map<string, TypedValue>();
    for (const e of rg.entries) {
      const spec = table[e.key];
      if (spec === undefined) {
        unsupportedFeature(issues, "UNKNOWN_KEYWORD", `the keyword ${e.key} in &${rg.name}`, e.line);
        continue;
      }
      if (spec.unsupported !== undefined) {
        unsupportedFeature(
          issues,
          spec.unsupported.code,
          `the keyword ${e.key} in &${rg.name} (${spec.unsupported.reason})`,
          e.line,
        );
        continue;
      }
      const typed = coerce(spec.type, e.values);
      if (typed === null) {
        invalid(issues, e.line, `${e.key} in &${rg.name} must be ${spec.type === "number" ? "a number" : spec.type === "boolean" ? ".TRUE. or .FALSE." : "text"}`);
        continue;
      }
      let values = typed;
      if (!spec.list && values.length > 1) {
        invalid(issues, e.line, `${e.key} in &${rg.name} takes one value, but ${values.length} were given; only the first is used`);
        values = values.slice(0, 1);
      }
      if (keys.has(e.key)) note(issues, e.line, `${e.key} appears twice in &${rg.name}; the last value is used`);
      keys.set(e.key, { line: e.line, values });
    }
    groups.push({ name: rg.name, line: rg.line, keys });
  }
  for (const [name, s] of skipped) {
    const what = SKIPPED_GROUP_NOTE[name];
    const detail = `${s.count === 1 ? "1 group" : `${s.count} groups`}, skipped${what !== undefined ? `; ${what}` : ""}`;
    issues.warnings.push(W.cfastUnsupported(`the group &${name} (${detail})`, s.line));
  }
  return groups;
}
