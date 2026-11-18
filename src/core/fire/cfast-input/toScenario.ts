// Typed CFAST groups to a Scenario (Req 15.1, 5.8, 4.7, 2.4). This file is the only place where CFAST input units meet SI.
// Mapping follows the CFAST 7.7.7 source (input_namelist.f90: read_comp, read_vent, read_fire, read_chem, read_tabl) and the
// User's Guide keyword appendix. Pure and total: problems become Warnings and unsupported reasons, never exceptions.
import {
  DEFAULT_AMBIENT_PRESSURE_PA,
  DEFAULT_AMBIENT_TEMP_K,
  DEFAULT_RELATIVE_HUMIDITY,
  KELVIN_AT_0C,
  MIN_FIRE_AREA_M2,
} from "../constants";
import type {
  Ambient,
  CeilingFloorVent,
  Compartment,
  CompartmentKind,
  Face,
  Fire,
  HrrRow,
  OpenFractionTable,
  Scenario,
  ScenarioOptions,
  Surface,
  SurfaceLayer,
  Vent,
  WallVent,
} from "../types";
import { ambientSpecies } from "./humidity";
import {
  boolOf,
  invalid,
  lineOf,
  note,
  numOf,
  numsOf,
  strOf,
  strsOf,
  unsupportedFeature,
  type Group,
  type Issues,
} from "./namelist";

// ---------------------------------------------------------------------------------------------
// Unit conversions, CFAST input unit to SI (design: CFAST input reader, unit table)
// ---------------------------------------------------------------------------------------------
const celsiusToK = (c: number): number => c + KELVIN_AT_0C; // &INIT temperatures are in degrees C
const percentToFraction = (p: number): number => p / 100; // &INIT RELATIVE_HUMIDITY is in %
const kJToJ = (kj: number): number => kj * 1000; // &MATL SPECIFIC_HEAT kJ/(kg K), &CHEM HEAT_OF_COMBUSTION kJ/kg
const kWToW = (kw: number): number => kw * 1000; // &TABL HRR is in kW
// &MATL CONDUCTIVITY is W/(m K) in the source and in the data. No conversion. &COMP/&VENT lengths are m. &TIME is s.

// CFAST 7.7.7 source, input_namelist.f90 line 1595 (set_defaults of read_chem): RADIATIVE_FRACTION defaults to 0.
// The User's Guide keyword table lists 0.35, but the source is what CFAST runs, so the reader follows the source.
const DEFAULT_RADIATIVE_FRACTION = 0;
const USERS_GUIDE_RADIATIVE_FRACTION = 0.35;
// CFAST 7.7.7 source, input_namelist.f90 (read_chem set_defaults): HEAT_OF_COMBUSTION 50000 kJ/kg.
const DEFAULT_HEAT_OF_COMBUSTION_KJ_PER_KG = 50000;
// CFAST 7.7.7 source, input_namelist.f90 (read_time set_defaults, cfast_parameters.f90): 900 s run, 60 s print interval.
const DEFAULT_SIMULATION_S = 900;
const DEFAULT_PRINT_S = 60;
// CFAST 7.7.7 source, input_namelist.f90 (read_matl set_defaults): emissivity 0.9.
const DEFAULT_EMISSIVITY = 0.9;
// Scenario.seed is unused by the physics (Req 11.3). The reader sets a fixed value so the output is deterministic.
const READER_SEED = 0;

const OUTSIDE = "OUTSIDE";

function first(groups: Group[], name: string, issues: Issues): Group | undefined {
  const all = groups.filter((g) => g.name === name);
  for (const extra of all.slice(1)) note(issues, extra.line, `a second &${name} group; only the first is used`);
  return all[0];
}

// ---------------------------------------------------------------------------------------------
// Materials and surfaces
// ---------------------------------------------------------------------------------------------
interface Material {
  name: string;
  conductivityWPerMK: number;
  densityKgPerM3: number;
  specificHeatJPerKgK: number;
  thicknessM: number;
  emissivity: number;
}

function readMaterials(groups: Group[], issues: Issues): Map<string, Material> {
  const out = new Map<string, Material>();
  for (const g of groups) {
    if (g.name !== "MATL") continue;
    const id = strOf(g, "ID");
    if (id === undefined) {
      invalid(issues, g.line, "a &MATL group has no ID");
      continue;
    }
    if (out.has(id)) {
      note(issues, g.line, `material "${id}" is defined twice; the first one is used`);
      continue;
    }
    // Missing numbers keep the CFAST default of 0 (emissivity 0.9) so the Input_Validator reports them.
    out.set(id, {
      name: id,
      conductivityWPerMK: numOf(g, "CONDUCTIVITY") ?? 0,
      densityKgPerM3: numOf(g, "DENSITY") ?? 0,
      specificHeatJPerKgK: kJToJ(numOf(g, "SPECIFIC_HEAT") ?? 0),
      thicknessM: numOf(g, "THICKNESS") ?? 0,
      emissivity: numOf(g, "EMISSIVITY") ?? DEFAULT_EMISSIVITY,
    });
  }
  return out;
}

// CFAST 7.7.7 source, input_namelist.f90 (read_comp): the material name OFF (or NULL) means no surface material.
const isOff = (id: string): boolean => id.toUpperCase() === "OFF" || id.toUpperCase() === "NULL";

// *_MATL_ID with the matching *_THICKNESS. A zero or missing thickness means the material's own THICKNESS (User's Guide).
// CFAST default for the material id is OFF, so a surface without material is adiabatic (Req 2.4).
function buildSurface(
  ids: string[] | undefined,
  thicknesses: number[] | undefined,
  materials: Map<string, Material>,
  compartmentId: string,
  surfaceName: string,
  line: number,
  issues: Issues,
): Surface {
  const layers: SurfaceLayer[] = [];
  (ids ?? []).forEach((id, k) => {
    if (isOff(id)) return;
    const m = materials.get(id);
    if (m === undefined) {
      invalid(issues, line, `compartment "${compartmentId}" ${surfaceName} uses material "${id}", which has no &MATL group`);
      return;
    }
    const t = thicknesses?.[k];
    layers.push({
      name: m.name,
      conductivityWPerMK: m.conductivityWPerMK,
      densityKgPerM3: m.densityKgPerM3,
      specificHeatJPerKgK: m.specificHeatJPerKgK,
      thicknessM: t !== undefined && t !== 0 ? t : m.thicknessM,
      emissivity: m.emissivity,
    });
  });
  if (layers.length === 0 && (ids ?? []).every(isOff)) return { adiabatic: true };
  return { layers };
}

// ---------------------------------------------------------------------------------------------
// Compartments
// ---------------------------------------------------------------------------------------------
function buildCompartment(g: Group, materials: Map<string, Material>, adiabatic: boolean, issues: Issues): Compartment | null {
  const id = strOf(g, "ID");
  if (id === undefined) {
    invalid(issues, g.line, "a &COMP group has no ID; the compartment was skipped");
    return null;
  }
  const surface = (key: string, thick: string, name: string): Surface =>
    adiabatic
      ? { adiabatic: true }
      : buildSurface(strsOf(g, key), numsOf(g, thick), materials, id, name, lineOf(g, key), issues);
  const shaft = boolOf(g, "SHAFT") === true;
  const hall = boolOf(g, "HALL") === true;
  if (shaft && hall) note(issues, g.line, `compartment "${id}" has SHAFT and HALL set; it is treated as a shaft`);
  const kind: CompartmentKind = shaft ? "shaft" : hall ? "corridor" : "room";
  if (g.keys.has("LEAK_AREA")) {
    note(issues, lineOf(g, "LEAK_AREA"), "LEAK_AREA is ignored, as CFAST ignores it; use LEAK_AREA_RATIO");
  }
  const c: Compartment = {
    id,
    widthM: numOf(g, "WIDTH") ?? 0,
    depthM: numOf(g, "DEPTH") ?? 0,
    heightM: numOf(g, "HEIGHT") ?? 0,
    floorElevationM: numsOf(g, "ORIGIN")?.[2] ?? 0, // ORIGIN = x, y, z; z is the floor elevation
    kind,
    ceiling: surface("CEILING_MATL_ID", "CEILING_THICKNESS", "ceiling"),
    floor: surface("FLOOR_MATL_ID", "FLOOR_THICKNESS", "floor"),
    walls: surface("WALL_MATL_ID", "WALL_THICKNESS", "walls"),
  };
  // LEAK_AREA_RATIO = wall, floor (CFAST 7.7.7 source, initialize_leakage; User's Guide example 0, 0.0005). Req 4.7.
  const ratios = numsOf(g, "LEAK_AREA_RATIO");
  if (ratios !== undefined) {
    const [wall, floor] = ratios;
    if (ratios.length > 2) note(issues, lineOf(g, "LEAK_AREA_RATIO"), "LEAK_AREA_RATIO takes two values (wall, floor); the others are ignored");
    const leakage: NonNullable<Compartment["leakage"]> = {};
    if (wall !== undefined && wall !== 0) leakage.wallAreaRatio = wall;
    if (floor !== undefined && floor !== 0) leakage.floorAreaRatio = floor;
    if (Object.keys(leakage).length > 0) c.leakage = leakage;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Vents
// ---------------------------------------------------------------------------------------------
// CFAST 7.7.7 source, read_vent: FACE FRONT, RIGHT, REAR, LEFT.
const FACES: Readonly<Record<string, Face>> = { FRONT: "front", RIGHT: "right", REAR: "back", LEFT: "left" };

type OpenResult = { ok: true; open: number | OpenFractionTable } | { ok: false };

function readOpen(g: Group, ventId: string, issues: Issues): OpenResult {
  const criterion = (strOf(g, "CRITERION") ?? "TIME").toUpperCase();
  if (criterion !== "TIME") {
    unsupportedFeature(issues, "UNSUPPORTED_VALUE", `vent "${ventId}" opens by CRITERION = '${criterion}'`, lineOf(g, "CRITERION"));
    return { ok: false };
  }
  const t = numsOf(g, "T");
  const f = numsOf(g, "F");
  if (t === undefined && f === undefined) return { ok: true, open: 1 };
  if (t === undefined || f === undefined) {
    invalid(issues, g.line, `vent "${ventId}" needs both T and F for an opening schedule; the vent was skipped`);
    return { ok: false };
  }
  if (t.length !== f.length) {
    note(issues, lineOf(g, "T"), `vent "${ventId}" has ${t.length} times but ${f.length} fractions; the extra values are ignored`);
  }
  const n = Math.min(t.length, f.length);
  return { ok: true, open: { timesS: t.slice(0, n), fractions: f.slice(0, n) } };
}

function buildVent(g: Group, index: number, issues: Issues): Vent | null {
  const rawId = strOf(g, "ID");
  const id = rawId ?? `VENT_${index + 1}`;
  if (rawId === undefined) note(issues, g.line, `a &VENT group has no ID; it is called ${id}`);
  const type = (strOf(g, "TYPE") ?? "").toUpperCase();
  if (type === "MECHANICAL") {
    unsupportedFeature(issues, "MECHANICAL_VENT", `the mechanical vent "${id}"`, g.line);
    return null;
  }
  const ends = strsOf(g, "COMP_IDS") ?? [];
  if (ends.length !== 2) {
    invalid(issues, g.line, `vent "${id}" needs two COMP_IDS, but has ${ends.length}; the vent was skipped`);
    return null;
  }
  const a = ends[0] as string;
  const b = ends[1] as string;
  const aOutside = a.toUpperCase() === OUTSIDE;
  const bOutside = b.toUpperCase() === OUTSIDE;
  if (type === "WALL") return buildWallVent(g, id, aOutside, bOutside, a, b, issues);
  if (type === "CEILING" || type === "FLOOR") return buildCeilingFloorVent(g, id, aOutside, bOutside, a, b, issues);
  invalid(issues, lineOf(g, "TYPE"), `vent "${id}" has TYPE '${strOf(g, "TYPE") ?? ""}'; use WALL, CEILING or FLOOR. The vent was skipped`);
  return null;
}

const endName = (name: string, outside: boolean): string => (outside ? OUTSIDE : name);

function buildWallVent(g: Group, id: string, aOutside: boolean, bOutside: boolean, a: string, b: string, issues: Issues): WallVent | null {
  const faceName = (strOf(g, "FACE") ?? "").toUpperCase();
  const face = FACES[faceName];
  if (face === undefined) {
    invalid(issues, lineOf(g, "FACE"), `vent "${id}" has FACE '${strOf(g, "FACE") ?? ""}'; use FRONT, RIGHT, REAR or LEFT. The vent was skipped`);
    return null;
  }
  const open = readOpen(g, id, issues);
  if (!open.ok) return null;
  // CFAST 7.7.7 source, read_vent: the order is kept unless one end is the Outside, which is always the second end.
  const swap = aOutside && !bOutside;
  const from = endName(swap ? b : a, swap ? bOutside : aOutside);
  const to = endName(swap ? a : b, swap ? aOutside : bOutside);
  const sillM = numOf(g, "BOTTOM") ?? 0;
  const topM = numOf(g, "TOP") ?? 0;
  const heightM = numOf(g, "HEIGHT") ?? 0;
  // CFAST 7.7.7 source, read_vent: soffit = TOP when TOP is not 0, otherwise BOTTOM + HEIGHT.
  const soffitM = topM !== 0 ? topM : sillM + heightM;
  return {
    kind: "wall",
    id,
    from,
    to,
    sillM,
    soffitM,
    widthM: numOf(g, "WIDTH") ?? 0,
    face,
    offsetM: numOf(g, "OFFSET") ?? 0,
    open: open.open,
  };
}

function buildCeilingFloorVent(
  g: Group,
  id: string,
  aOutside: boolean,
  bOutside: boolean,
  a: string,
  b: string,
  issues: Issues,
): CeilingFloorVent | null {
  const shapeName = (strOf(g, "SHAPE") ?? "ROUND").toUpperCase(); // design: ROUND is the default
  if (shapeName !== "ROUND" && shapeName !== "SQUARE") {
    invalid(issues, lineOf(g, "SHAPE"), `vent "${id}" has SHAPE '${strOf(g, "SHAPE") ?? ""}'; use ROUND or SQUARE. The vent was skipped`);
    return null;
  }
  const open = readOpen(g, id, issues);
  if (!open.ok) return null;
  const vent: CeilingFloorVent = {
    kind: "ceilingFloor",
    id,
    // COMP_IDS lists the top compartment first and the bottom compartment second (CFAST 7.7.7 source, read_vent).
    upper: endName(a, aOutside),
    lower: endName(b, bOutside),
    areaM2: numOf(g, "AREA") ?? 0,
    shape: shapeName === "SQUARE" ? "square" : "round",
    open: open.open,
  };
  const offsets = numsOf(g, "OFFSETS");
  if (offsets !== undefined) {
    if (offsets.length !== 2) {
      invalid(issues, lineOf(g, "OFFSETS"), `vent "${id}" needs two OFFSETS (x, y), but has ${offsets.length}; the vent was skipped`);
      return null;
    }
    vent.offsetM = [offsets[0] as number, offsets[1] as number];
  }
  return vent;
}

// ---------------------------------------------------------------------------------------------
// Fires
// ---------------------------------------------------------------------------------------------
// CFAST 7.7.7 User's Guide, &TABL: default column order when LABELS is not given.
const DEFAULT_LABELS = ["TIME", "HRR", "HEIGHT", "AREA", "CO_YIELD", "SOOT_YIELD", "HCN_YIELD", "HCL_YIELD", "TRACE_YIELD"];
// Columns the Scenario has no field for. A non-zero value changes the physics, so it marks the case unsupported.
const ZERO_ONLY_COLUMNS = new Set(["HCN_YIELD", "HCL_YIELD", "TRACE_YIELD"]);
const KNOWN_COLUMNS = new Set(["TIME", "HRR", "HEIGHT", "AREA", "CO_YIELD", "SOOT_YIELD", ...ZERO_ONLY_COLUMNS]);

interface Table {
  labels: string[] | null;
  labelsLine: number;
  rows: { line: number; values: number[] }[];
}

function readTables(groups: Group[]): Map<string, Table> {
  const tables = new Map<string, Table>();
  for (const g of groups) {
    if (g.name !== "TABL") continue;
    const id = strOf(g, "ID");
    if (id === undefined) continue;
    let t = tables.get(id);
    if (t === undefined) {
      t = { labels: null, labelsLine: g.line, rows: [] };
      tables.set(id, t);
    }
    const labels = strsOf(g, "LABELS");
    if (labels !== undefined) {
      t.labels = labels.map((l) => l.toUpperCase());
      t.labelsLine = lineOf(g, "LABELS");
    }
    const data = numsOf(g, "DATA");
    if (data !== undefined) t.rows.push({ line: lineOf(g, "DATA"), values: data });
  }
  return tables;
}

function buildTable(fireId: string, table: Table, issues: Issues): HrrRow[] | null {
  let labels = table.labels;
  if (labels === null) {
    note(issues, table.labelsLine, `table of fire "${fireId}" has no LABELS; the default column order was used`);
    labels = DEFAULT_LABELS;
  }
  const column = (name: string): number => labels.indexOf(name);
  for (const l of labels) {
    if (!KNOWN_COLUMNS.has(l)) {
      unsupportedFeature(issues, "UNSUPPORTED_VALUE", `the table column ${l} of fire "${fireId}"`, table.labelsLine);
    }
  }
  const iTime = column("TIME");
  const iHrr = column("HRR");
  if (iTime < 0 || iHrr < 0) {
    invalid(issues, table.labelsLine, `table of fire "${fireId}" needs the columns TIME and HRR; the fire was skipped`);
    return null;
  }
  const iHeight = column("HEIGHT");
  const iArea = column("AREA");
  const iCo = column("CO_YIELD");
  const iSoot = column("SOOT_YIELD");
  const rows: HrrRow[] = [];
  for (const r of table.rows) {
    if (r.values.length !== labels.length) {
      invalid(issues, r.line, `a data row of fire "${fireId}" has ${r.values.length} values, but the table has ${labels.length} columns; the row was skipped`);
      continue;
    }
    labels.forEach((l, i) => {
      if (ZERO_ONLY_COLUMNS.has(l) && r.values[i] !== 0) {
        unsupportedFeature(issues, "UNSUPPORTED_VALUE", `a non-zero ${l} of fire "${fireId}"`, r.line);
      }
    });
    const at = (i: number, fallback: number): number => (i < 0 ? fallback : (r.values[i] as number));
    rows.push({
      timeS: r.values[iTime] as number,
      hrrW: kWToW(r.values[iHrr] as number),
      heightM: at(iHeight, 0),
      // CFAST 7.7.7 source, read_chem: a missing area is the smallest fire area, pi/4 * 0.2^2.
      areaM2: at(iArea, MIN_FIRE_AREA_M2),
      coYield: at(iCo, 0),
      sootYield: at(iSoot, 0),
    });
  }
  return rows;
}

function buildFires(groups: Group[], issues: Issues): Fire[] {
  const chems = new Map<string, Group>();
  for (const g of groups) {
    const id = strOf(g, "ID");
    if (g.name === "CHEM" && id !== undefined && !chems.has(id)) chems.set(id, g);
  }
  const tables = readTables(groups);
  const fires: Fire[] = [];
  for (const g of groups) {
    if (g.name !== "FIRE") continue;
    const id = strOf(g, "ID");
    const fireId = strOf(g, "FIRE_ID");
    if (id === undefined || fireId === undefined) {
      invalid(issues, g.line, "a &FIRE group needs ID and FIRE_ID; the fire was skipped");
      continue;
    }
    const chem = chems.get(fireId);
    const table = tables.get(fireId);
    if (chem === undefined || table === undefined) {
      invalid(issues, g.line, `fire "${id}" needs a &CHEM and a &TABL with ID = '${fireId}'; the fire was skipped`);
      continue;
    }
    const rows = buildTable(id, table, issues);
    if (rows === null) continue;
    const criterion = (strOf(g, "IGNITION_CRITERION") ?? "TIME").toUpperCase();
    let ignitionTimeS: number | undefined;
    if (criterion === "TIME") {
      const setpoint = numOf(g, "SETPOINT") ?? 0;
      if (setpoint > 0) ignitionTimeS = setpoint; // CFAST: a setpoint of 0 means the fire burns from the start
    } else if (criterion !== "NULL") {
      unsupportedFeature(issues, "UNSUPPORTED_VALUE", `fire "${id}" ignites by IGNITION_CRITERION = '${criterion}'`, lineOf(g, "IGNITION_CRITERION"));
    }
    let radiativeFraction = numOf(chem, "RADIATIVE_FRACTION");
    if (radiativeFraction === undefined) {
      radiativeFraction = DEFAULT_RADIATIVE_FRACTION;
      note(
        issues,
        chem.line,
        `&CHEM '${fireId}' has no RADIATIVE_FRACTION; ${DEFAULT_RADIATIVE_FRACTION} was used (the CFAST 7.7.7 source default; the User's Guide table lists ${USERS_GUIDE_RADIATIVE_FRACTION}, but the source uses ${DEFAULT_RADIATIVE_FRACTION})`,
      );
    }
    const location = numsOf(g, "LOCATION");
    if (location !== undefined && location.length !== 2) {
      invalid(issues, lineOf(g, "LOCATION"), `fire "${id}" needs LOCATION = x, y; the fire was skipped`);
      continue;
    }
    const fire: Fire = {
      id,
      compartmentId: strOf(g, "COMP_ID") ?? "",
      xM: location?.[0] ?? 0,
      yM: location?.[1] ?? 0,
      radiativeFraction,
      fuel: {
        c: numOf(chem, "CARBON") ?? 0,
        h: numOf(chem, "HYDROGEN") ?? 0,
        o: numOf(chem, "OXYGEN") ?? 0,
        n: numOf(chem, "NITROGEN") ?? 0,
        cl: numOf(chem, "CHLORINE") ?? 0,
        heatOfCombustionJPerKg: kJToJ(numOf(chem, "HEAT_OF_COMBUSTION") ?? DEFAULT_HEAT_OF_COMBUSTION_KJ_PER_KG),
      },
      table: rows,
    };
    if (ignitionTimeS !== undefined) fire.ignitionTimeS = ignitionTimeS;
    fires.push(fire);
  }
  return fires;
}

// ---------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------
function buildAmbient(init: Group | undefined): Ambient {
  const interiorK = init !== undefined && numOf(init, "INTERIOR_TEMPERATURE") !== undefined
    ? celsiusToK(numOf(init, "INTERIOR_TEMPERATURE") as number)
    : DEFAULT_AMBIENT_TEMP_K;
  const exteriorK = init !== undefined && numOf(init, "EXTERIOR_TEMPERATURE") !== undefined
    ? celsiusToK(numOf(init, "EXTERIOR_TEMPERATURE") as number)
    : DEFAULT_AMBIENT_TEMP_K;
  const rhPercent = init !== undefined ? numOf(init, "RELATIVE_HUMIDITY") : undefined;
  const rh = rhPercent !== undefined ? percentToFraction(rhPercent) : DEFAULT_RELATIVE_HUMIDITY;
  return {
    interiorTempK: interiorK,
    exteriorTempK: exteriorK,
    pressurePa: (init !== undefined ? numOf(init, "PRESSURE") : undefined) ?? DEFAULT_AMBIENT_PRESSURE_PA,
    species: ambientSpecies(interiorK, rh),
  };
}

/** Typed groups to a Scenario, or null when the file has no compartment. The result is not validated. */
export function toScenario(groups: Group[], issues: Issues): Scenario | null {
  const head = first(groups, "HEAD", issues);
  const time = first(groups, "TIME", issues);
  const init = first(groups, "INIT", issues);
  const misc = first(groups, "MISC", issues);
  const materials = readMaterials(groups, issues);
  const adiabatic = misc !== undefined && boolOf(misc, "ADIABATIC") === true;

  const compartments: Compartment[] = [];
  for (const g of groups) {
    if (g.name !== "COMP") continue;
    const c = buildCompartment(g, materials, adiabatic, issues);
    if (c !== null) compartments.push(c);
  }
  if (!groups.some((g) => g.name === "COMP")) {
    note(issues, 1, "the input has no &COMP group, so there is no scenario to build");
    return null;
  }

  const vents: Vent[] = [];
  let ventIndex = 0;
  for (const g of groups) {
    if (g.name !== "VENT") continue;
    const v = buildVent(g, ventIndex, issues);
    ventIndex += 1;
    if (v !== null) vents.push(v);
  }

  const scenario: Scenario = {
    schemaVersion: 1,
    durationS: (time !== undefined ? numOf(time, "SIMULATION") : undefined) ?? DEFAULT_SIMULATION_S,
    printIntervalS: (time !== undefined ? numOf(time, "PRINT") : undefined) ?? DEFAULT_PRINT_S,
    seed: READER_SEED,
    ambient: buildAmbient(init),
    compartments,
    vents,
    fires: buildFires(groups, issues),
  };
  const title = head !== undefined ? strOf(head, "TITLE") : undefined;
  if (title !== undefined) scenario.title = title;
  if (misc !== undefined) {
    const options: ScenarioOptions = {};
    const maxStep = numOf(misc, "MAX_TIME_STEP");
    if (maxStep !== undefined) options.maxTimeStepS = maxStep;
    if (adiabatic) options.adiabatic = true;
    if (Object.keys(options).length > 0) scenario.options = options;
  }
  return scenario;
}
