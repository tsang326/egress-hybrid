// Reader for CFAST 7.7.7 `*_compartments.csv` and `*_vents.csv` reference files (fire-zone Req 15.5, 13.1).
// Node and test use only. Parses text as data; never throws, returns warnings instead.
//
// File layout (checked on validation/reference/steckler/Steckler_010_*.csv and delco/Test_03_*.csv):
//   row 1: variable names  (Time, ULT_1, ...)
//   row 2: long labels
//   row 3: entity names    (compartment name, fire name, vent name, or "Outside")
//   row 4: units
//   rows 5..: fixed-width scientific values (" 0.755362338415E+02,") with padding spaces.

/** Kelvin offset for CFAST temperatures given in °C. */
const CELSIUS_TO_KELVIN = 273.15; // exact definition of the Celsius scale

/** Molar masses in kg/mol used by CFAST 7.7.7 chemistry routine (CFAST 7.7.7 source, fire.f90, chemistry; design.md). */
export const CFAST_MOLAR_MASS_KG_PER_MOL = {
  O2: 0.032,
  CO2: 0.04401,
  CO: 0.02801,
  H2O: 0.018016,
  N2: 0.02802,
} as const;

export type SpeciesName = keyof typeof CFAST_MOLAR_MASS_KG_PER_MOL;
const SPECIES_NAMES = Object.keys(CFAST_MOLAR_MASS_KG_PER_MOL) as SpeciesName[];

/** Cap on repeated per-value warnings so a corrupt file cannot flood the output. */
const MAX_VALUE_WARNINGS = 20;

export type Layer = 'upper' | 'lower';

export type CompartmentQuantity =
  | 'tempK' // layer temperature, K (CSV °C + 273.15); `layer` is set
  | 'tempRiseK' // layer temperature minus its t = 0 value, K; `layer` is set
  | 'layerHeightM' // HGT_n, m
  | 'upperVolumeM3' // VOL_n, m3
  | 'pressurePa' // PRS_n, Pa relative
  | 'moleFraction' // UL<sp>_n / LL<sp>_n, mol/mol, report only; `layer` and `species` set
  | 'opticalDensityMgM3' // ULOD_n / LLOD_n, mg/m3, report only; `layer` set
  | 'hrrW' // HRR_n actual, W
  | 'hrrExpectedW'; // HRR_En expected, W

export type VentQuantity =
  | 'netInflow' // as written by CFAST: from the SECOND compartment's side (see ventNetOutflowOfFirst)
  | 'openFraction'
  | 'inflowUpper' // positive, relative to the FIRST compartment of the vent
  | 'outflowUpper'
  | 'inflowLower'
  | 'outflowLower';

export type VentKind = 'wall' | 'ceilingFloor' | 'leakage';

export interface ReferenceColumn {
  /** Header row 3: compartment name, fire name or vent name. */
  readonly entity: string;
  readonly quantity: CompartmentQuantity | VentQuantity;
  readonly layer?: Layer;
  readonly species?: SpeciesName;
  /** Trailing index n of the CFAST column name (compartment, fire or vent number). */
  readonly index: number;
  /** Original CSV column name. */
  readonly csvName: string;
  readonly kind?: VentKind;
  /** Unit after conversion. */
  readonly unit: string;
  readonly values: Float64Array;
}

export interface ReferenceTable {
  readonly timesS: Float64Array;
  readonly columns: readonly ReferenceColumn[];
  readonly warnings: readonly string[];
}

interface ColumnSpec {
  readonly quantity: CompartmentQuantity | VentQuantity;
  readonly layer?: Layer;
  readonly species?: SpeciesName;
  readonly index: number;
  readonly kind?: VentKind;
  /** Scale and offset applied to raw values. */
  readonly offset: number;
  readonly unit: string;
  /** Marks a temperature column that also yields a Rise column. */
  readonly rise?: boolean;
}

const layerOf = (p: string): Layer => (p === 'UL' ? 'upper' : 'lower');

/** Maps a compartments-file column name to a spec, or undefined if the column is not used. */
export function classifyCompartmentColumn(name: string): ColumnSpec | undefined {
  let m = /^(ULT|LLT)_(\d+)$/.exec(name);
  if (m) {
    return { quantity: 'tempK', layer: layerOf((m[1] as string).slice(0, 2)), index: Number(m[2]), offset: CELSIUS_TO_KELVIN, unit: 'K', rise: true };
  }
  m = /^(HGT|VOL|PRS)_(\d+)$/.exec(name);
  if (m) {
    const table = { HGT: ['layerHeightM', 'm'], VOL: ['upperVolumeM3', 'm^3'], PRS: ['pressurePa', 'Pa'] } as const;
    const [quantity, unit] = table[m[1] as 'HGT' | 'VOL' | 'PRS'];
    return { quantity, index: Number(m[2]), offset: 0, unit };
  }
  m = /^(UL|LL)OD_(\d+)$/.exec(name);
  if (m) return { quantity: 'opticalDensityMgM3', layer: layerOf(m[1] as string), index: Number(m[2]), offset: 0, unit: 'mg/m^3' };
  m = /^(UL|LL)(N2|O2|CO2|CO|H2O)_(\d+)$/.exec(name);
  if (m) {
    return { quantity: 'moleFraction', layer: layerOf(m[1] as string), species: m[2] as SpeciesName, index: Number(m[3]), offset: 0, unit: 'mol/mol' };
  }
  m = /^HRR_E(\d+)$/.exec(name);
  if (m) return { quantity: 'hrrExpectedW', index: Number(m[1]), offset: 0, unit: 'W' };
  m = /^HRR_(\d+)$/.exec(name);
  if (m) return { quantity: 'hrrW', index: Number(m[1]), offset: 0, unit: 'W' };
  return undefined;
}

/** Maps a vents-file column name to a spec, or undefined if the column is not used. */
export function classifyVentColumn(name: string): ColumnSpec | undefined {
  const kg = 'kg/s';
  let m = /^WT_.+_([ul])_(inflow|outflow)_(\d+)$/.exec(name);
  if (m) return layerFlow('wall', m[1] as string, m[2] as string, Number(m[3]));
  m = /^CFT_.+_([ul])_(inflow|outflow)_(\d+)$/.exec(name);
  if (m) return layerFlow('ceilingFloor', m[1] as string, m[2] as string, Number(m[3]));
  m = /^WF_.+_(\d+)$/.exec(name);
  if (m) return { quantity: 'openFraction', index: Number(m[1]), kind: 'wall', offset: 0, unit: '1' };
  // CFAST writes the ceiling/floor opening fraction as CFF_<a>_<b>_<n>.
  m = /^CFF_.+_(\d+)$/.exec(name);
  if (m) return { quantity: 'openFraction', index: Number(m[1]), kind: 'ceilingFloor', offset: 0, unit: '1' };
  m = /^W_.+_(\d+)$/.exec(name);
  if (m) return { quantity: 'netInflow', index: Number(m[1]), kind: 'wall', offset: 0, unit: kg };
  m = /^CF_.+_(\d+)$/.exec(name);
  if (m) return { quantity: 'netInflow', index: Number(m[1]), kind: 'ceilingFloor', offset: 0, unit: kg };
  m = /^L_.+_(\d+)$/.exec(name);
  if (m) return { quantity: 'netInflow', index: Number(m[1]), kind: 'leakage', offset: 0, unit: kg };
  return undefined;

  function layerFlow(kind: VentKind, u: string, dir: string, index: number): ColumnSpec {
    const upper = u === 'u';
    const quantity: VentQuantity = dir === 'inflow' ? (upper ? 'inflowUpper' : 'inflowLower') : upper ? 'outflowUpper' : 'outflowLower';
    return { quantity, index, kind, offset: 0, unit: kg };
  }
}

function emptyTable(warnings: string[]): ReferenceTable {
  return { timesS: new Float64Array(0), columns: [], warnings };
}

/** Parses one CFAST output CSV. `file` selects the column mapping. Never throws. */
export function parseReferenceCsv(text: string, file: 'compartments' | 'vents'): ReferenceTable {
  const warnings: string[] = [];
  try {
    return parseInner(text, file, warnings);
  } catch (e) {
    warnings.push(`reference CSV could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
    return emptyTable(warnings);
  }
}

function splitRow(line: string): string[] {
  return line.split(',').map((c) => c.trim());
}

function parseInner(text: string, file: 'compartments' | 'vents', warnings: string[]): ReferenceTable {
  if (typeof text !== 'string') {
    warnings.push('reference CSV text is not a string');
    return emptyTable(warnings);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 4) {
    warnings.push(`expected 4 header rows, found ${lines.length} non-empty lines`);
    return emptyTable(warnings);
  }
  const names = splitRow(lines[0] as string);
  const entities = splitRow(lines[2] as string);
  const units = splitRow(lines[3] as string);
  const nCols = names.length;
  if (names[0] !== 'Time') warnings.push(`first column is "${names[0] ?? ''}", expected "Time"`);
  if (entities.length !== nCols || units.length !== nCols) {
    warnings.push(`header rows have different column counts (${nCols}, ${entities.length}, ${units.length})`);
  }

  const dataLines = lines.slice(4);
  const nRows = dataLines.length;
  const raw: Float64Array[] = [];
  for (let c = 0; c < nCols; c++) raw.push(new Float64Array(nRows));
  let valueWarnings = 0;
  for (let r = 0; r < nRows; r++) {
    const cells = splitRow(dataLines[r] as string);
    if (cells.length !== nCols && valueWarnings < MAX_VALUE_WARNINGS) {
      warnings.push(`data row ${r + 5} has ${cells.length} values, expected ${nCols}; missing values are NaN`);
      valueWarnings++;
    }
    for (let c = 0; c < nCols; c++) {
      const cell = cells[c];
      const v = cell === undefined || cell === '' ? Number.NaN : Number(cell);
      if (Number.isNaN(v) && cell !== undefined && cell !== '' && valueWarnings < MAX_VALUE_WARNINGS) {
        warnings.push(`data row ${r + 5}, column ${names[c] ?? c}: "${cell.slice(0, 20)}" is not a number`);
        valueWarnings++;
      }
      (raw[c] as Float64Array)[r] = v;
    }
  }

  const classify = file === 'compartments' ? classifyCompartmentColumn : classifyVentColumn;
  const columns: ReferenceColumn[] = [];
  for (let c = 1; c < nCols; c++) {
    const name = names[c] ?? '';
    const spec = classify(name);
    if (!spec) continue;
    const entity = entities[c] ?? '';
    const src = raw[c] as Float64Array;
    const csvUnit = units[c] ?? '';
    if (spec.quantity === 'tempK' && csvUnit !== 'C') warnings.push(`column ${name}: unit "${csvUnit}", expected "C"; no conversion check possible`);
    const values = new Float64Array(nRows);
    for (let r = 0; r < nRows; r++) values[r] = (src[r] as number) + spec.offset;
    columns.push(makeColumn(spec, entity, name, spec.quantity, values));
    if (spec.rise) {
      const t0 = nRows > 0 ? (values[0] as number) : Number.NaN; // Rise is relative to the t = 0 value (Req 13.1)
      const rise = new Float64Array(nRows);
      for (let r = 0; r < nRows; r++) rise[r] = (values[r] as number) - t0;
      columns.push(makeColumn(spec, entity, name, 'tempRiseK', rise));
    }
  }
  if (columns.length === 0) warnings.push('no recognised columns found');
  return { timesS: raw[0] ?? new Float64Array(0), columns, warnings };
}

function makeColumn(spec: ColumnSpec, entity: string, csvName: string, quantity: ReferenceColumn['quantity'], values: Float64Array): ReferenceColumn {
  return {
    entity,
    quantity,
    index: spec.index,
    csvName,
    unit: spec.unit,
    values,
    ...(spec.layer !== undefined ? { layer: spec.layer } : {}),
    ...(spec.species !== undefined ? { species: spec.species } : {}),
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
  };
}

/** Finds the column for { entity, quantity } and optional layer/species/index. */
export function findColumn(
  table: ReferenceTable,
  key: { entity: string; quantity: ReferenceColumn['quantity']; layer?: Layer; species?: SpeciesName; index?: number },
): ReferenceColumn | undefined {
  return table.columns.find(
    (c) =>
      c.entity === key.entity &&
      c.quantity === key.quantity &&
      (key.layer === undefined || c.layer === key.layer) &&
      (key.species === undefined || c.species === key.species) &&
      (key.index === undefined || c.index === key.index),
  );
}

/**
 * Net mass flow OUT of the first compartment of a vent, kg/s, from the four layer columns
 * (positive layer flows are relative to the first compartment; design.md sign convention).
 * Equals the CSV `netInflow` column, which CFAST computes from the second compartment's side.
 */
export function ventNetOutflowOfFirst(table: ReferenceTable, entity: string, index: number): Float64Array | undefined {
  const get = (q: VentQuantity): Float64Array | undefined => findColumn(table, { entity, quantity: q, index })?.values;
  const iu = get('inflowUpper');
  const ou = get('outflowUpper');
  const il = get('inflowLower');
  const ol = get('outflowLower');
  if (!iu || !ou || !il || !ol) return undefined;
  const out = new Float64Array(iu.length);
  for (let r = 0; r < out.length; r++) out[r] = (ou[r] as number) + (ol[r] as number) - (iu[r] as number) - (il[r] as number);
  return out;
}

/**
 * Converts mole fractions to mass fractions over the five species with known molar masses (report only).
 * Species not in the list (HCN, HCl, unburned fuel) are ignored; they are zero or negligible in the cases.
 */
export function speciesMassFractions(moleFractions: Readonly<Record<SpeciesName, number>>): Record<SpeciesName, number> {
  let total = 0;
  for (const s of SPECIES_NAMES) total += moleFractions[s] * CFAST_MOLAR_MASS_KG_PER_MOL[s];
  const out = {} as Record<SpeciesName, number>;
  for (const s of SPECIES_NAMES) out[s] = total > 0 ? (moleFractions[s] * CFAST_MOLAR_MASS_KG_PER_MOL[s]) / total : Number.NaN;
  return out;
}
