// Tests for the CFAST input reader (Requirements 15.1 to 15.4, 15.6).
// Files in validation/cases/ are read here with node:fs; src/core never touches the file system.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ambientSpecies, parseCfastInput } from "../../src/core/fire/cfast-input";
import type { CfastInputResult } from "../../src/core/fire/cfast-input";
import type { Scenario } from "../../src/core/fire/types";
import { validate } from "../../src/core/fire/validate/validate";

const CASES_DIR = join(__dirname, "..", "..", "validation", "cases");

function listCases(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listCases(p));
    else if (name.endsWith(".in")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Independent scan of a CFAST file with regular expressions (no use of the reader's tokenizer)
// ---------------------------------------------------------------------------------------------
interface ScanGroup {
  name: string;
  body: string;
}

function scanGroups(text: string): ScanGroup[] {
  const noComments = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("!"))
    .join("\n");
  return [...noComments.matchAll(/&([A-Z]+)([^/]*)\//g)].map((m) => ({ name: m[1] as string, body: m[2] as string }));
}

/** First number after `KEY =` in a group body, or undefined. */
function scanNumber(body: string, key: string): number | undefined {
  const m = new RegExp(`\\b${key}\\s*=\\s*(-?[0-9.]+(?:[eE][-+]?[0-9]+)?)`).exec(body);
  return m === null ? undefined : Number(m[1]);
}

/** All numbers after `KEY =` up to the next keyword. */
function scanNumbers(body: string, key: string): number[] {
  const m = new RegExp(`\\b${key}\\s*=([^=A-Za-z']*)`).exec(body);
  return m === null ? [] : [...(m[1] as string).matchAll(/-?[0-9.]+(?:[eE][-+]?[0-9]+)?/g)].map((n) => Number(n[0]));
}

function scanString(body: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*=\\s*'([^']*)'`).exec(body);
  return m === null ? undefined : (m[1] as string);
}

function scanScenario(text: string) {
  const groups = scanGroups(text);
  const comps = groups
    .filter((g) => g.name === "COMP")
    .map((g) => ({
      widthM: scanNumber(g.body, "WIDTH"),
      depthM: scanNumber(g.body, "DEPTH"),
      heightM: scanNumber(g.body, "HEIGHT"),
    }));
  const vents = groups
    .filter((g) => g.name === "VENT")
    .map((g) => ({
      type: scanString(g.body, "TYPE"),
      width: scanNumber(g.body, "WIDTH"),
      height: scanNumber(g.body, "HEIGHT"),
      bottom: scanNumber(g.body, "BOTTOM") ?? 0,
      area: scanNumber(g.body, "AREA"),
    }));
  // HRR per &FIRE in file order: the HRR column of the &TABL rows that share the &FIRE's FIRE_ID, in kW.
  const fires = groups
    .filter((g) => g.name === "FIRE")
    .map((g) => {
      const fireId = scanString(g.body, "FIRE_ID");
      const tabl = groups.filter((t) => t.name === "TABL" && scanString(t.body, "ID") === fireId);
      const labels = [...(tabl.find((t) => /LABELS/.test(t.body))?.body.matchAll(/'([A-Z_]+)'/g) ?? [])].map((m) => m[1]);
      const hrrCol = labels.length > 0 ? labels.indexOf("HRR") : 1;
      const timeCol = labels.length > 0 ? labels.indexOf("TIME") : 0;
      const rows = tabl.filter((t) => /\bDATA\b/.test(t.body)).map((t) => scanNumbers(t.body, "DATA"));
      return {
        timesS: rows.map((r) => r[timeCol] as number),
        hrrW: rows.map((r) => (r[hrrCol] as number) * 1000),
      };
    });
  return { comps, vents, fires };
}

// ---------------------------------------------------------------------------------------------
// Validation cases (Requirement 15.6)
// ---------------------------------------------------------------------------------------------
describe("CFAST input reader on validation/cases", () => {
  const files = listCases(CASES_DIR);

  it("finds the 21 case files", () => {
    expect(files).toHaveLength(21);
  });

  for (const file of files) {
    it(`${relative(CASES_DIR, file)}: parses, is supported, and matches an independent scan`, () => {
      const text = readFileSync(file, "utf8");
      let result!: CfastInputResult;
      expect(() => {
        result = parseCfastInput(text);
      }).not.toThrow();
      expect(result.unsupported).toEqual([]);
      const scenario = result.scenario as Scenario;
      expect(scenario).not.toBeNull();
      // Every case sets RADIATIVE_FRACTION itself, so the default never applies.
      expect(result.warnings.filter((w) => w.message.includes("RADIATIVE_FRACTION"))).toEqual([]);
      // Requirement 4.10: no case has a wall vent that misses its second compartment.
      expect(validate(scenario).warnings.map((w) => w.code)).not.toContain("VENT_NO_VERTICAL_OVERLAP");

      const scan = scanScenario(text);

      expect(scenario.compartments).toHaveLength(scan.comps.length);
      scan.comps.forEach((c, i) => {
        expect(scenario.compartments[i]?.widthM).toBe(c.widthM);
        expect(scenario.compartments[i]?.depthM).toBe(c.depthM);
        expect(scenario.compartments[i]?.heightM).toBe(c.heightM);
      });

      expect(scenario.vents).toHaveLength(scan.vents.length);
      scan.vents.forEach((v, i) => {
        const got = scenario.vents[i];
        if (v.type === "WALL") {
          expect(got?.kind).toBe("wall");
          if (got?.kind !== "wall") return;
          expect(got.widthM).toBe(v.width);
          expect(got.sillM).toBe(v.bottom);
          expect(got.soffitM - got.sillM).toBeCloseTo(v.height as number, 12);
        } else {
          expect(got?.kind).toBe("ceilingFloor");
          if (got?.kind !== "ceilingFloor") return;
          expect(got.areaM2).toBe(v.area);
        }
      });

      expect(scenario.fires).toHaveLength(scan.fires.length);
      scan.fires.forEach((f, i) => {
        const table = scenario.fires[i]?.table ?? [];
        expect(table.map((r) => r.timeS)).toEqual(f.timesS);
        expect(table.map((r) => r.hrrW)).toEqual(f.hrrW);
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Unsupported paths (Requirement 15.3)
// ---------------------------------------------------------------------------------------------
const BASE = `&HEAD VERSION = 7600, TITLE = 'fixture' /
&TIME SIMULATION = 100 PRINT = 10 /
&COMP ID = 'A' WIDTH = 3 DEPTH = 4 HEIGHT = 2.5 ORIGIN = 0, 0, 0 /
`;

describe("unsupported CFAST features", () => {
  it("a supported fixture has no unsupported reason", () => {
    const r = parseCfastInput(BASE);
    expect(r.unsupported).toEqual([]);
    expect(r.scenario?.compartments).toHaveLength(1);
  });

  it("mechanical vent", () => {
    const r = parseCfastInput(
      `${BASE}&VENT TYPE = 'MECHANICAL' ID = 'fan' COMP_IDS = 'A' 'OUTSIDE' AREA = 0.1 /\n`,
    );
    expect(r.unsupported.map((u) => u.code)).toEqual(["MECHANICAL_VENT"]);
    expect(r.unsupported[0]?.line).toBe(4);
    expect(r.scenario?.vents).toEqual([]);
  });

  it("CROSS_SECT_AREAS", () => {
    const r = parseCfastInput(
      `&COMP ID = 'A' WIDTH = 3 DEPTH = 4 HEIGHT = 2.5\n  CROSS_SECT_AREAS = 1, 2 CROSS_SECT_HEIGHTS = 0, 2.5 /\n`,
    );
    expect(r.unsupported.map((u) => u.code)).toEqual(["CROSS_SECTION", "CROSS_SECTION"]);
    expect(r.unsupported[0]?.line).toBe(2);
  });

  it("unknown keyword", () => {
    const r = parseCfastInput(`${BASE.replace("HEIGHT = 2.5", "HEIGHT = 2.5 NOT_A_KEYWORD = 3")}`);
    expect(r.unsupported.map((u) => u.code)).toEqual(["UNKNOWN_KEYWORD"]);
    expect(r.unsupported[0]?.line).toBe(3);
  });

  it("&CONN", () => {
    const r = parseCfastInput(`${BASE}&CONN TYPE = 'WALL' COMP_ID = 'A' COMP_IDS = 'A' /\n`);
    expect(r.unsupported.map((u) => u.code)).toEqual(["UNSUPPORTED_GROUP"]);
    expect(r.unsupported[0]?.line).toBe(4);
  });

  it("a &CHEM without RADIATIVE_FRACTION gets 0 (CFAST source) and a warning that names the User's Guide value", () => {
    const text =
      `${BASE}&MATL ID = 'M' CONDUCTIVITY = 1 SPECIFIC_HEAT = 1 DENSITY = 1000 THICKNESS = 0.1 EMISSIVITY = 0.9 /\n` +
      `&CHEM ID = 'F' CARBON = 1 HYDROGEN = 4 HEAT_OF_COMBUSTION = 50000 /\n` +
      `&TABL ID = 'F' LABELS = 'TIME', 'HRR', 'HEIGHT', 'AREA', 'CO_YIELD', 'SOOT_YIELD', 'HCN_YIELD', 'HCL_YIELD', 'TRACE_YIELD' /\n` +
      `&TABL ID = 'F' DATA = 0, 0, 0, 0.1, 0, 0, 0, 0, 0 /\n` +
      `&TABL ID = 'F' DATA = 10, 1000, 0, 0.1, 0, 0, 0, 0, 0 /\n` +
      `&FIRE ID = 'F' COMP_ID = 'A' FIRE_ID = 'F' LOCATION = 1, 1 /\n`;
    const r = parseCfastInput(text);
    expect(r.scenario?.fires[0]?.radiativeFraction).toBe(0);
    const w = r.warnings.find((x) => x.message.includes("RADIATIVE_FRACTION"));
    expect(w?.message).toContain("User's Guide");
    expect(w?.message).toContain("0.35");
  });

  it("every warning of these fixtures carries a line number", () => {
    const r = parseCfastInput(`${BASE}&CONN TYPE = 'WALL' /\n&VENT TYPE = 'MECHANICAL' ID = 'f' /\n`);
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const w of r.warnings) expect(w.location.field).toMatch(/^line \d+$/);
  });
});

// ---------------------------------------------------------------------------------------------
// Humidity (CFAST fit)
// ---------------------------------------------------------------------------------------------
describe("humidity at 26 C and 50 %", () => {
  // Hand calculation, T = 299.15 K:
  //   Psat = exp(23.2 - 3816 / (299.15 - 46)) = exp(23.2 - 15.0742) = 3381.02 Pa
  //   x_sat = 3381.02 / 101325 * 18.016 / 28.584 = 0.0210313
  //   raw water = 0.5 * x_sat = 0.0105157; total = 0.77 + 0.23 + raw = 1.0105157
  //   H2O = 0.0105157 / 1.0105157 = 0.0104062; O2 = 0.23 / 1.0105157 = 0.2276066
  it("matches the hand-computed value", () => {
    const s = ambientSpecies(26 + 273.15, 0.5);
    expect(s.h2o).toBeCloseTo(0.0104062, 6);
    expect(s.o2).toBeCloseTo(0.2276066, 6);
    expect(s.h2o + s.o2 + 0.77 / 1.0105157).toBeCloseTo(1, 6);
  });

  it("is what the reader puts in the Scenario for &INIT", () => {
    const r = parseCfastInput(`${BASE}&INIT INTERIOR_TEMPERATURE = 26 EXTERIOR_TEMPERATURE = 26 RELATIVE_HUMIDITY = 50 /\n`);
    expect(r.scenario?.ambient.species.h2o).toBeCloseTo(0.0104062, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------------------------
// Feature: fire-zone, Property 26: CFAST input reader is total and reports line numbers
// **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
describe("Property 26: CFAST input reader is total and reports line numbers", () => {
  const fragment = fc.constantFrom(
    "&COMP", "&VENT", "&FIRE", "&TABL", "&CHEM", "&MATL", "&CONN", "&DEVC", "&INIT", "&TIME", "&MISC", "&HEAD", "&",
    "ID", "TYPE", "COMP_IDS", "WIDTH", "DEPTH", "HEIGHT", "DATA", "LABELS", "CROSS_SECT_AREAS", "T", "F", "AREA",
    "=", ",", "/", "'", "''", "'OUTSIDE'", "'MECHANICAL'", "'WALL'", ".TRUE.", ".FALSE.", "1", "-2.5", "1e400", "NaN",
    "0", "!", "!! c", " ", "\n", "\r\n", "\t", "\u0000", "é",
  );
  const arbText = fc.oneof(
    fc.string({ maxLength: 300 }),
    fc.string({ unit: "binary", maxLength: 200 }),
    fc.array(fragment, { maxLength: 80 }).map((a) => a.join(" ")),
    fc.array(fragment, { maxLength: 80 }).map((a) => `${BASE}${a.join("")}`),
  );

  it("never throws and every warning has a line number within 1..line count", () => {
    fc.assert(
      fc.property(arbText, (text) => {
        const r = parseCfastInput(text);
        const lineCount = text.split("\n").length;
        for (const w of r.warnings) {
          const m = /^line (\d+)$/.exec(w.location.field ?? "");
          expect(m).not.toBeNull();
          const n = Number(m?.[1]);
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(lineCount);
        }
        for (const u of r.unsupported) {
          expect(u.line).toBeGreaterThanOrEqual(1);
          expect(u.line).toBeLessThanOrEqual(lineCount);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(arbText, (text) => {
        expect(parseCfastInput(text)).toEqual(parseCfastInput(text));
      }),
    );
  });
});
