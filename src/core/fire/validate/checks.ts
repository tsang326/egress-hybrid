// Input_Validator checks (design: Input_Validator). One function per rule, each returns Warning[].
// The input is untrusted at this point, so every check reads it as `unknown` and never throws.
// A value that is NaN or infinite is reported once by `checkFiniteNumbers`; the other checks skip it.
import {
  HEAT_OF_COMBUSTION_MAX_J_PER_KG,
  HEAT_OF_COMBUSTION_MIN_J_PER_KG,
} from "../constants";
import * as W from "./warnings";
import type { Warning, WarningLocation } from "./warnings";

export type Rec = Record<string, unknown>;

// Requirement 1.1, 1.4.
export const MAX_COMPARTMENTS = 30;
export const MAX_FLOORS = 6;
export const MAX_VENTS = 60;
// Requirement 1.1 / design: floor levels are distinct when they differ by more than this, m.
export const FLOOR_LEVEL_TOLERANCE_M = 0.01;
// Requirement 2.8: stacking tolerance, m.
export const STACKING_TOLERANCE_M = 0.01;
// Requirement 2.3, design Input_Validator rule 4 (Tech Ref chapter 5): layers per surface.
export const MAX_SURFACE_LAYERS = 3;
// Requirement 4.3, 5.3: open-fraction table size.
export const MIN_TABLE_PAIRS = 2;
export const MAX_TABLE_PAIRS = 1000;
// Requirement 1.7, 6.1: HRR table size.
export const MIN_HRR_ROWS = 2;
export const MAX_HRR_ROWS = 10000;
// Requirement 4.7 (Tech Ref 4.4): leakage area upper bound, m2.
export const MAX_LEAKAGE_AREA_M2 = 100;
// Depth limit of the finite-number walk (the Scenario nests about 5 levels).
const MAX_WALK_DEPTH = 12;

export const OUTSIDE = "OUTSIDE";
const SPECIES = ["o2", "co2", "co", "h2o", "soot"] as const;
const SURFACES = ["ceiling", "floor", "walls"] as const;

export interface FlagTarget {
  kind: "compartment" | "vent";
  id: string;
}

// ---------------------------------------------------------------------------------------------
// Small readers

export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Rec {
  return isRec(v) ? v : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type NumState = "ok" | "bad" | "skip"; // skip: NaN or infinite, already reported by the walk

function numState(v: unknown): NumState {
  if (typeof v !== "number") return "bad";
  return Number.isFinite(v) ? "ok" : "skip";
}

/** True when v is a finite number greater than zero. */
function isPos(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Report a field that must be a finite number > 0. Non-finite numbers are left to the walk. */
function posField(
  code: "INVALID_DIMENSION" | "AMBIENT_INVALID",
  loc: WarningLocation,
  field: string,
  value: unknown,
  requirement = "a finite number greater than 0",
): Warning[] {
  const s = numState(value);
  if (s === "skip") return [];
  if (s === "bad" || (value as number) <= 0) return [W.invalidField(code, loc, field, requirement)];
  return [];
}

function compartmentIds(s: Rec): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const c of arr(s["compartments"])) {
    const id = str(rec(c)["id"]);
    if (!m.has(id)) m.set(id, rec(c));
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// 2. Counts (Req 1.1, 1.4)

export function checkCounts(s: Rec): Warning[] {
  const out: Warning[] = [];
  const comps = arr(s["compartments"]);
  if (comps.length < 1 || comps.length > MAX_COMPARTMENTS) {
    out.push(W.limitExceeded("LIMIT_COMPARTMENTS", comps.length, `1 to ${MAX_COMPARTMENTS} compartments`));
  }
  const levels = distinctFloorLevels(comps);
  if (levels > MAX_FLOORS) {
    out.push(W.limitExceeded("LIMIT_FLOORS", levels, `1 to ${MAX_FLOORS} floor levels`));
  }
  const vents = arr(s["vents"]);
  if (vents.length > MAX_VENTS) {
    out.push(W.limitExceeded("LIMIT_VENTS", vents.length, `0 to ${MAX_VENTS} vents`));
  }
  return out;
}

/** Number of floor levels, where levels within 0.01 m of the lowest member of their group are one level. */
function distinctFloorLevels(comps: unknown[]): number {
  const e: number[] = [];
  for (const c of comps) {
    const z = rec(c)["floorElevationM"];
    if (typeof z === "number" && Number.isFinite(z)) e.push(z);
  }
  e.sort((a, b) => a - b);
  let count = 0;
  let groupStart = Number.NaN;
  for (const z of e) {
    if (count === 0 || z - groupStart > FLOOR_LEVEL_TOLERANCE_M) {
      count += 1;
      groupStart = z;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// 3. Finite-number walk (Req 1.9)

export function checkFiniteNumbers(s: Rec): Warning[] {
  const out: Warning[] = [];
  walk(s, "", 0, out);
  return out;
}

function walk(v: unknown, path: string, depth: number, out: Warning[]): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(W.notFinite(path === "" ? "scenario" : path));
    return;
  }
  if (depth >= MAX_WALK_DEPTH || typeof v !== "object" || v === null) return;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) walk(v[i], `${path}[${i}]`, depth + 1, out);
    return;
  }
  for (const k of Object.keys(v)) {
    walk((v as Rec)[k], path === "" ? k : `${path}.${k}`, depth + 1, out);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Compartments and surfaces (Req 1.3, 2.2, 2.4, 3.7)

export function checkCompartments(s: Rec): Warning[] {
  const out: Warning[] = [];
  const seen = new Set<string>();
  for (const raw of arr(s["compartments"])) {
    const c = rec(raw);
    const id = str(c["id"]);
    if (seen.has(id)) out.push(W.duplicateId("compartment", id));
    seen.add(id);
    const loc: WarningLocation = { kind: "compartment", id };
    for (const f of ["widthM", "depthM", "heightM"] as const) {
      out.push(...posField("INVALID_DIMENSION", loc, f, c[f]));
    }
    if (numState(c["floorElevationM"]) === "bad") {
      out.push(W.invalidField("INVALID_ELEVATION", loc, "floorElevationM", "a finite number"));
    }
    for (const name of SURFACES) out.push(...checkSurface(id, name, c[name]));
    out.push(...checkMaterials(id, c));
  }
  return out;
}

function checkSurface(compartmentId: string, name: string, surface: unknown): Warning[] {
  if (!isRec(surface)) return [W.surfaceMissing(compartmentId, name)];
  if (surface["adiabatic"] === true) return [];
  const layers = surface["layers"];
  if (!Array.isArray(layers) || layers.length === 0) return [W.surfaceMissing(compartmentId, name)];
  if (layers.length > MAX_SURFACE_LAYERS) return [W.surfaceLayerCount(compartmentId, name, layers.length)];
  return [];
}

// ---------------------------------------------------------------------------------------------
// 5. Materials (Req 1.3, 2.7, 7.6)

const LAYER_FIELDS = [
  "conductivityWPerMK",
  "densityKgPerM3",
  "specificHeatJPerKgK",
  "thicknessM",
] as const;

export function checkMaterials(compartmentId: string, c: Rec): Warning[] {
  const out: Warning[] = [];
  for (const name of SURFACES) {
    const surface = rec(c[name]);
    const layers = surface["layers"];
    if (!Array.isArray(layers) || layers.length > MAX_SURFACE_LAYERS) continue;
    layers.forEach((rawLayer, i) => {
      const layer = rec(rawLayer);
      const material = str(layer["name"]) || `${compartmentId}.${name}`;
      for (const f of LAYER_FIELDS) {
        const st = numState(layer[f]);
        if (st === "bad" || (st === "ok" && (layer[f] as number) <= 0)) {
          out.push(W.materialInvalid(material, i, f));
        }
      }
      const e = layer["emissivity"];
      const es = numState(e);
      if (es === "bad") out.push(W.emissivityRange(material, i, Number.NaN));
      else if (es === "ok" && ((e as number) < 0 || (e as number) > 1)) {
        out.push(W.emissivityRange(material, i, e as number));
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 6. Ambient (Req 3.7, 8.3)

export function checkAmbient(s: Rec): Warning[] {
  const out: Warning[] = [];
  const a = s["ambient"];
  if (!isRec(a)) {
    return [W.invalidField("AMBIENT_INVALID", { kind: "scenario" }, "ambient", "an object with temperatures, pressure and species")];
  }
  for (const f of ["interiorTempK", "exteriorTempK", "pressurePa"] as const) {
    out.push(...posField("AMBIENT_INVALID", { kind: "scenario" }, `ambient.${f}`, a[f]));
  }
  const sp = rec(a["species"]);
  for (const k of SPECIES) {
    const v = sp[k];
    if (typeof v !== "number") out.push(W.ambientSpeciesMissing(k));
    else if (Number.isFinite(v) && (v < 0 || v > 1)) out.push(W.ambientSpeciesRange(k, v));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 7. Vents (Req 1.5, 1.6, 4.4, 4.7, 5.4)

export function checkVents(s: Rec): Warning[] {
  const out: Warning[] = [];
  const comps = compartmentIds(s);
  const seen = new Set<string>();
  for (const raw of arr(s["vents"])) {
    const v = rec(raw);
    const id = str(v["id"]);
    if (seen.has(id)) out.push(W.duplicateId("vent", id));
    seen.add(id);
    if (v["kind"] === "wall") out.push(...checkWallVent(id, v, comps));
    else if (v["kind"] === "ceilingFloor") out.push(...checkCeilingFloorVent(id, v, comps));
    else if (v["kind"] === "leakage") out.push(...checkLeakageVent(id, v, comps));
    else out.push(W.ventOutOfBounds(id, "kind", "must be wall, ceilingFloor or leakage"));
  }
  return out;
}

/** Existing compartments at the ends of a vent; reports missing references. */
function resolveEnds(id: string, refs: unknown[], comps: Map<string, Rec>, out: Warning[]): Rec[] {
  const found: Rec[] = [];
  for (const ref of refs) {
    const name = typeof ref === "string" ? ref : "";
    if (name === OUTSIDE) continue;
    const c = comps.get(name);
    if (c === undefined) out.push(W.ventCompartmentMissing(id, name));
    else found.push(c);
  }
  return found;
}

function minOf(values: unknown[]): number | null {
  const nums = values.filter(isPos);
  return nums.length === 0 ? null : Math.min(...nums);
}

function checkWallVent(id: string, v: Rec, comps: Map<string, Rec>): Warning[] {
  const out: Warning[] = [];
  const ends = resolveEnds(id, [v["from"], v["to"]], comps, out);
  const heightM = minOf(ends.map((c) => c["heightM"]));
  const face = v["face"];
  // Face and offset are measured on the wall of the first compartment end (CFAST 7.7.7 source, read_vent: positions are
  // relative to the "inside" room). The other end may have a shorter wall that only overlaps the vent (DelCo Test_02).
  const wallLengths = ends.slice(0, 1).map((c) => (face === "left" || face === "right" ? c["depthM"] : c["widthM"]));
  const wallLengthM = minOf(wallLengths);

  const sill = v["sillM"];
  const soffit = v["soffitM"];
  const width = v["widthM"];
  const offset = v["offsetM"];
  if (face !== "front" && face !== "back" && face !== "left" && face !== "right") {
    out.push(W.ventOutOfBounds(id, "face", "must be front, back, left or right"));
  }
  if (numState(sill) === "bad" || (numState(sill) === "ok" && (sill as number) < 0)) {
    out.push(W.ventOutOfBounds(id, "sillM", "must be a finite number of at least 0 m"));
  }
  if (numState(soffit) === "bad") {
    out.push(W.ventOutOfBounds(id, "soffitM", "must be a finite number"));
  } else if (numState(soffit) === "ok") {
    if (numState(sill) === "ok" && (soffit as number) <= (sill as number)) {
      out.push(W.ventOutOfBounds(id, "soffitM", "must be above the sill"));
    }
    if (heightM !== null && (soffit as number) > heightM) {
      out.push(W.ventOutOfBounds(id, "soffitM", `is above the compartment height of ${heightM} m`));
    }
  }
  if (numState(width) === "bad" || (numState(width) === "ok" && (width as number) <= 0)) {
    out.push(W.ventOutOfBounds(id, "widthM", "must be a finite number greater than 0 m"));
  } else if (numState(width) === "ok" && wallLengthM !== null) {
    const off = numState(offset) === "ok" ? (offset as number) : 0;
    if (numState(offset) === "bad" || (numState(offset) === "ok" && off < 0)) {
      out.push(W.ventOutOfBounds(id, "offsetM", "must be a finite number of at least 0 m"));
    } else if (off + (width as number) > wallLengthM) {
      out.push(W.ventOutOfBounds(id, "widthM", `with its offset extends past the wall length of ${wallLengthM} m`));
    }
  } else if (numState(offset) === "bad") {
    out.push(W.ventOutOfBounds(id, "offsetM", "must be a finite number of at least 0 m"));
  }
  out.push(...checkVerticalOverlap(id, v, comps));
  out.push(...checkOpen(id, v["open"]));
  return out;
}

/**
 * Req 4.10: sill and soffit are measured from the floor of the first compartment (`from`). Converted to absolute
 * elevation, the span must overlap the height range of the second compartment. CFAST 7.7.7 checks the first only.
 */
function checkVerticalOverlap(id: string, v: Rec, comps: Map<string, Rec>): Warning[] {
  const fromId = str(v["from"]);
  const toId = str(v["to"]);
  const from = comps.get(fromId);
  const to = comps.get(toId);
  if (from === undefined || to === undefined) return [];
  const nums = [v["sillM"], v["soffitM"], from["floorElevationM"], to["floorElevationM"], to["heightM"]];
  if (!nums.every((x) => typeof x === "number" && Number.isFinite(x))) return [];
  const [sill, soffit, fromFloor, toFloor, toHeight] = nums as number[];
  const absSill = (fromFloor as number) + (sill as number);
  const absSoffit = (fromFloor as number) + (soffit as number);
  const toCeiling = (toFloor as number) + (toHeight as number);
  if (absSill >= toCeiling || absSoffit <= (toFloor as number)) {
    return [W.ventNoVerticalOverlap(id, fromId, toId, absSill, absSoffit, toFloor as number, toCeiling)];
  }
  return [];
}

function checkCeilingFloorVent(id: string, v: Rec, comps: Map<string, Rec>): Warning[] {
  const out: Warning[] = [];
  const ends = resolveEnds(id, [v["lower"], v["upper"]], comps, out);
  const area = v["areaM2"];
  if (numState(area) === "bad" || (numState(area) === "ok" && (area as number) <= 0)) {
    out.push(W.invalidField("VENT_AREA_INVALID", { kind: "vent", id }, "areaM2", "a finite number greater than 0 m2"));
  } else if (numState(area) === "ok") {
    const footprints = ends.map((c) =>
      isPos(c["widthM"]) && isPos(c["depthM"]) ? c["widthM"] * c["depthM"] : null,
    );
    const known = footprints.filter((f): f is number => f !== null);
    if (known.length > 0 && (area as number) > Math.min(...known)) {
      out.push(W.ventOutOfBounds(id, "areaM2", `is larger than the compartment floor area of ${Math.min(...known)} m2`));
    }
  }
  if (v["shape"] !== "round" && v["shape"] !== "square") {
    out.push(W.ventOutOfBounds(id, "shape", "must be round or square"));
  }
  const off = v["offsetM"];
  if (off !== undefined) {
    const okPair = Array.isArray(off) && off.length === 2 && off.every((x) => numState(x) !== "bad");
    if (!okPair) out.push(W.ventOutOfBounds(id, "offsetM", "must be a pair of numbers"));
  }
  out.push(...checkOpen(id, v["open"]));
  return out;
}

function checkLeakageVent(id: string, v: Rec, comps: Map<string, Rec>): Warning[] {
  const out: Warning[] = [];
  const cid = str(v["compartmentId"]);
  if (!comps.has(cid)) out.push(W.ventCompartmentMissing(id, cid));
  const area = v["areaM2"];
  const st = numState(area);
  if (st === "bad") out.push(W.leakageAreaInvalid(id, Number.NaN));
  else if (st === "ok" && ((area as number) <= 0 || (area as number) > MAX_LEAKAGE_AREA_M2)) {
    out.push(W.leakageAreaInvalid(id, area as number));
  }
  if (v["orientation"] !== "wall" && v["orientation"] !== "floor") {
    out.push(W.ventOutOfBounds(id, "orientation", "must be wall or floor"));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 7b. Open-fraction tables (Req 4.3, 4.4, 5.3, 5.4)

export function checkOpen(ventId: string, open: unknown): Warning[] {
  if (typeof open === "number") {
    if (!Number.isFinite(open)) return []; // reported by the walk
    return open < 0 || open > 1 ? [W.openTableInvalid(ventId, "has an open fraction outside 0 to 1")] : [];
  }
  if (!isRec(open)) return [W.openTableInvalid(ventId, "is missing: give a number or a table")];
  const times = open["timesS"];
  const fractions = open["fractions"];
  if (!Array.isArray(times) || !Array.isArray(fractions)) {
    return [W.openTableInvalid(ventId, "needs the lists timesS and fractions")];
  }
  const out: Warning[] = [];
  if (times.length !== fractions.length) {
    out.push(W.openTableInvalid(ventId, "has different numbers of times and fractions"));
  }
  const n = Math.min(times.length, fractions.length);
  if (n < MIN_TABLE_PAIRS || n > MAX_TABLE_PAIRS) {
    out.push(W.openTableInvalid(ventId, `has ${n} pairs, but it needs ${MIN_TABLE_PAIRS} to ${MAX_TABLE_PAIRS}`));
  }
  let prev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const t = times[i];
    const f = fractions[i];
    if (numState(t) === "bad") out.push(W.openTableInvalid(ventId, "has a time that is not a number", i));
    else if (numState(t) === "ok") {
      if ((t as number) < 0) out.push(W.openTableInvalid(ventId, "has a negative time", i));
      else if ((t as number) <= prev) out.push(W.openTableInvalid(ventId, "has times that do not increase", i));
      prev = t as number;
    }
    if (numState(f) === "bad") out.push(W.openTableInvalid(ventId, "has a fraction that is not a number", i));
    else if (numState(f) === "ok" && ((f as number) < 0 || (f as number) > 1)) {
      out.push(W.openTableInvalid(ventId, "has a fraction outside 0 to 1", i));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 8. Fires (Req 1.7, 1.8, 6.1, 6.2, 6.5, 6.6)

const HRR_COLUMNS = [
  { key: "hrrW", rule: "must be 0 or more", ok: (v: number) => v >= 0 },
  { key: "heightM", rule: "must be 0 or more", ok: (v: number) => v >= 0 },
  { key: "areaM2", rule: "must be above 0", ok: (v: number) => v > 0 },
  { key: "coYield", rule: "must be between 0 and 1", ok: (v: number) => v >= 0 && v <= 1 },
  { key: "sootYield", rule: "must be between 0 and 1", ok: (v: number) => v >= 0 && v <= 1 },
] as const;

export function checkFires(s: Rec): Warning[] {
  const out: Warning[] = [];
  const comps = compartmentIds(s);
  const seen = new Set<string>();
  for (const raw of arr(s["fires"])) {
    const f = rec(raw);
    const id = str(f["id"]);
    if (seen.has(id)) out.push(W.duplicateId("fire", id));
    seen.add(id);
    const cid = str(f["compartmentId"]);
    const comp = comps.get(cid);
    if (comp === undefined) out.push(W.fireCompartmentMissing(id, cid));
    else out.push(...checkFirePosition(id, cid, f, comp));
    out.push(...checkFireValues(id, f));
    out.push(...checkHrrTable(id, f["table"]));
  }
  return out;
}

function checkFirePosition(id: string, cid: string, f: Rec, comp: Rec): Warning[] {
  const x = f["xM"];
  const y = f["yM"];
  const w = comp["widthM"];
  const d = comp["depthM"];
  const xs = numState(x);
  const ys = numState(y);
  if (xs === "skip" || ys === "skip") return [];
  if (xs === "bad" || ys === "bad") return [W.fireOutsideCompartment(id, cid)];
  const outside =
    (isPos(w) && ((x as number) < 0 || (x as number) > w)) || (isPos(d) && ((y as number) < 0 || (y as number) > d));
  return outside ? [W.fireOutsideCompartment(id, cid)] : [];
}

function checkFireValues(id: string, f: Rec): Warning[] {
  const out: Warning[] = [];
  const rf = f["radiativeFraction"];
  const rs = numState(rf);
  if (rs === "bad" || (rs === "ok" && ((rf as number) < 0 || (rf as number) > 1))) {
    out.push(W.fireValueInvalid("FIRE_RADIATIVE_FRACTION", id, "radiativeFraction", "a number between 0 and 1"));
  }
  const fuel = rec(f["fuel"]);
  const c = fuel["c"];
  if (numState(c) === "bad" || (numState(c) === "ok" && (c as number) <= 0)) {
    out.push(W.fireValueInvalid("FIRE_FUEL_INVALID", id, "fuel.c", "a number above 0"));
  }
  for (const k of ["h", "o", "n", "cl"] as const) {
    const v = fuel[k];
    if (numState(v) === "bad" || (numState(v) === "ok" && (v as number) < 0)) {
      out.push(W.fireValueInvalid("FIRE_FUEL_INVALID", id, `fuel.${k}`, "a number of 0 or more"));
    }
  }
  const hoc = fuel["heatOfCombustionJPerKg"];
  if (numState(hoc) === "bad" || (numState(hoc) === "ok" && (hoc as number) <= 0)) {
    out.push(W.fireValueInvalid("FIRE_FUEL_INVALID", id, "fuel.heatOfCombustionJPerKg", "a number above 0"));
  }
  return out;
}

export function checkHrrTable(fireId: string, table: unknown): Warning[] {
  if (!Array.isArray(table)) return [W.hrrTableInvalid(fireId, "is missing", null)];
  const out: Warning[] = [];
  if (table.length < MIN_HRR_ROWS || table.length > MAX_HRR_ROWS) {
    out.push(
      W.hrrTableInvalid(fireId, `has ${table.length} rows, but it needs ${MIN_HRR_ROWS} to ${MAX_HRR_ROWS}`, null),
    );
  }
  let prev = Number.NEGATIVE_INFINITY;
  table.forEach((raw, i) => {
    const row = rec(raw);
    const t = row["timeS"];
    const ts = numState(t);
    if (ts === "bad") out.push(W.hrrTableInvalid(fireId, "must be a number", i, "timeS"));
    else if (ts === "ok") {
      if ((t as number) < 0) out.push(W.hrrTableInvalid(fireId, "must be 0 or more", i, "timeS"));
      else if ((t as number) <= prev) out.push(W.hrrTableInvalid(fireId, "must be larger than the time in the row before", i, "timeS"));
      prev = t as number;
    }
    for (const col of HRR_COLUMNS) {
      const v = row[col.key];
      const st = numState(v);
      if (st === "bad") out.push(W.hrrTableInvalid(fireId, "must be a number", i, col.key));
      else if (st === "ok" && !col.ok(v as number)) out.push(W.hrrTableInvalid(fireId, col.rule, i, col.key));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// 9. Output (Req 10.3)

export function checkOutput(s: Rec): Warning[] {
  const out: Warning[] = [];
  const d = s["durationS"];
  const p = s["printIntervalS"];
  const ds = numState(d);
  const ps = numState(p);
  const durationOk = ds === "ok" && (d as number) > 0;
  if (ds === "bad" || (ds === "ok" && (d as number) <= 0)) out.push(W.durationInvalid(Number(d)));
  if (ps === "bad" || (ps === "ok" && (p as number) <= 0)) out.push(W.printIntervalInvalid(Number(p), Number(d)));
  else if (ps === "ok" && durationOk && (p as number) > (d as number)) {
    out.push(W.printIntervalInvalid(p as number, d as number));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 10. Soft checks (Req 2.8, 5.7, 5.8, 5.9, 6.12, design Fire modules step 3). None of these blocks the run.

/** Req 2.8: compartments joined by a ceiling or floor vent must stack within 0.01 m. */
export function checkStacking(s: Rec): Warning[] {
  const out: Warning[] = [];
  const comps = compartmentIds(s);
  for (const raw of arr(s["vents"])) {
    const v = rec(raw);
    if (v["kind"] !== "ceilingFloor") continue;
    const lower = comps.get(str(v["lower"]));
    const upper = comps.get(str(v["upper"]));
    if (lower === undefined || upper === undefined) continue;
    const zl = lower["floorElevationM"];
    const hl = lower["heightM"];
    const zu = upper["floorElevationM"];
    if (![zl, hl, zu].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    const gap = Math.abs((zu as number) - ((zl as number) + (hl as number)));
    if (gap > STACKING_TOLERANCE_M) out.push(W.stackingMismatch(str(v["lower"]), str(v["upper"]), gap));
  }
  return out;
}

/** Req 5.9, 6.12: each unsupported item gives a warning and is dropped. */
export function checkUnsupported(s: Rec): Warning[] {
  const out: Warning[] = [];
  for (const raw of arr(s["unsupported"])) {
    const u = rec(raw);
    out.push(W.unsupportedItem(str(u["kind"]) || "unknown", str(u["id"])));
  }
  return out;
}

/** Design Fire modules step 3: heat of combustion outside the clamp range, for tables that release heat. */
export function checkHeatOfCombustion(s: Rec): Warning[] {
  const out: Warning[] = [];
  for (const raw of arr(s["fires"])) {
    const f = rec(raw);
    const hoc = rec(f["fuel"])["heatOfCombustionJPerKg"];
    if (!isPos(hoc)) continue;
    const releases = arr(f["table"]).some((r) => {
      const q = rec(r)["hrrW"];
      return typeof q === "number" && q > 0;
    });
    if (releases && (hoc < HEAT_OF_COMBUSTION_MIN_J_PER_KG || hoc > HEAT_OF_COMBUSTION_MAX_J_PER_KG)) {
      out.push(W.heatOfCombustionRange(str(f["id"]), hoc, HEAT_OF_COMBUSTION_MIN_J_PER_KG, HEAT_OF_COMBUSTION_MAX_J_PER_KG));
    }
  }
  return out;
}

/**
 * Req 5.7, 5.8: compartments that are stairs, shafts or corridors, and vents that touch a stair or shaft.
 * Returns the targets in a stable order (compartments in input order, then vents in input order).
 */
export function stairShaftTargets(s: Rec): FlagTarget[] {
  const out: FlagTarget[] = [];
  const special = new Set<string>(); // stairs and shafts
  for (const raw of arr(s["compartments"])) {
    const c = rec(raw);
    const id = str(c["id"]);
    const kind = c["kind"];
    const isShaftLike = c["isStair"] === true || kind === "shaft";
    if (isShaftLike) special.add(id);
    if (isShaftLike || kind === "corridor") out.push({ kind: "compartment", id });
  }
  for (const raw of arr(s["vents"])) {
    const v = rec(raw);
    const ends =
      v["kind"] === "wall"
        ? [v["from"], v["to"]]
        : v["kind"] === "ceilingFloor"
          ? [v["lower"], v["upper"]]
          : [v["compartmentId"]];
    if (ends.some((e) => typeof e === "string" && special.has(e))) {
      out.push({ kind: "vent", id: str(v["id"]) });
    }
  }
  return out;
}
