// Tests for validation/harness/referenceCsv.ts (fire-zone task 13.2; Requirements 15.5, 13.1).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  findColumn,
  parseReferenceCsv,
  ventNetOutflowOfFirst,
  type ReferenceTable,
} from './referenceCsv';

const REFERENCE_DIR = join(import.meta.dirname, '..', 'reference');

// ---------- Property 27 helpers: write a CSV in the CFAST layout ----------

/** Column names the compartments reader accepts, with the long label and the CSV unit CFAST prints. */
const COLUMN_POOL: readonly { name: string; unit: string; offset: number; outUnit: string }[] = [
  { name: 'ULT_1', unit: 'C', offset: 273.15, outUnit: 'K' },
  { name: 'LLT_1', unit: 'C', offset: 273.15, outUnit: 'K' },
  { name: 'HGT_1', unit: 'm', offset: 0, outUnit: 'm' },
  { name: 'VOL_1', unit: 'm^3', offset: 0, outUnit: 'm^3' },
  { name: 'PRS_1', unit: 'Pa', offset: 0, outUnit: 'Pa' },
  { name: 'ULO2_1', unit: 'mol_frac', offset: 0, outUnit: 'mol/mol' },
  { name: 'LLCO2_1', unit: 'mol_frac', offset: 0, outUnit: 'mol/mol' },
  { name: 'ULOD_1', unit: 'mg/m^3', offset: 0, outUnit: 'mg/m^3' },
  { name: 'HRR_E1', unit: 'W', offset: 0, outUnit: 'W' },
  { name: 'HRR_1', unit: 'W', offset: 0, outUnit: 'W' },
];

/** Formats like CFAST: fixed width, 0.dddddddddddd E+ee, with a leading space for positive values. */
function formatCfast(v: number): string {
  if (v === 0) return ' 0.000000000000E+00';
  const e = Math.floor(Math.log10(Math.abs(v))) + 1;
  const m = Math.abs(v) / 10 ** e;
  const sign = v < 0 ? '-' : ' ';
  const es = `${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return `${sign}${m.toFixed(12)}E${es}`;
}

const valueArb = fc.oneof(
  fc.constant(0),
  fc.double({ min: 1e-6, max: 1e7, noNaN: true }),
  fc.double({ min: -1e5, max: -1e-6, noNaN: true }),
);

const tableArb = fc
  .record({
    picks: fc.uniqueArray(fc.integer({ min: 0, max: COLUMN_POOL.length - 1 }), { minLength: 1, maxLength: COLUMN_POOL.length }),
    nRows: fc.integer({ min: 1, max: 12 }),
    entity: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,10}$/),
    crlf: fc.boolean(),
  })
  .chain((r) =>
    fc.record({
      times: fc.array(fc.double({ min: 0, max: 1e5, noNaN: true }), { minLength: r.nRows, maxLength: r.nRows }),
      data: fc.array(fc.array(valueArb, { minLength: r.nRows, maxLength: r.nRows }), { minLength: r.picks.length, maxLength: r.picks.length }),
      picks: fc.constant(r.picks),
      entity: fc.constant(r.entity.trim() === '' ? 'Compartment 1' : r.entity.trim()),
      crlf: fc.constant(r.crlf),
    }),
  );

describe('referenceCsv', () => {
  // Feature: fire-zone, Property 27: Reference CSV round trip
  // **Validates: Requirements 15.5**
  it('Property 27: names, entities, units and values survive a write/parse round trip', () => {
    fc.assert(
      fc.property(tableArb, ({ times, data, picks, entity, crlf }) => {
        const cols = picks.map((p) => COLUMN_POOL[p]!);
        const nl = crlf ? '\r\n' : '\n';
        const line = (cells: string[]) => cells.join(',') + ',';
        const rows = [
          line(['Time', ...cols.map((c) => c.name)]),
          line(['Simulation Time', ...cols.map((c) => `Label ${c.name}`)]),
          line(['Time', ...cols.map(() => entity)]),
          line(['s', ...cols.map((c) => c.unit)]),
        ];
        const printed: number[][] = cols.map(() => []);
        const printedTimes: number[] = [];
        for (let r = 0; r < times.length; r++) {
          const tText = formatCfast(times[r]!);
          printedTimes.push(Number(tText));
          const cells = [tText];
          cols.forEach((_, c) => {
            const text = formatCfast(data[c]![r]!);
            printed[c]!.push(Number(text));
            cells.push(text);
          });
          rows.push(line(cells));
        }
        const table = parseReferenceCsv(rows.join(nl) + nl, 'compartments');
        expect(table.warnings).toEqual([]);
        expect(Array.from(table.timesS)).toEqual(printedTimes);
        cols.forEach((spec, c) => {
          const quantityName = findColumnByCsvName(table, spec.name);
          expect(quantityName, spec.name).toBeDefined();
          expect(quantityName!.entity).toBe(entity);
          expect(quantityName!.unit).toBe(spec.outUnit);
          expect(quantityName!.values.length).toBe(times.length);
          for (let r = 0; r < times.length; r++) {
            const expected = printed[c]![r]! + spec.offset;
            expect(Math.abs(quantityName!.values[r]! - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
          }
        });
      }),
      { numRuns: 100 },
    );
  });

  // ---------- Unit tests on the committed reference files ----------

  const pairs = listCasePairs();

  it('finds the 21 committed case pairs', () => {
    expect(pairs.length).toBe(21);
  });

  it.each(pairs)('loads $name without warnings', ({ comp, vents }) => {
    const c = parseReferenceCsv(readFileSync(comp, 'utf8'), 'compartments');
    const v = parseReferenceCsv(readFileSync(vents, 'utf8'), 'vents');
    expect(c.warnings).toEqual([]);
    // Cases without vents have a vents file with only the Time column; the reader says so.
    const noVents = readFileSync(vents, 'utf8').split('\n')[0]!.trim().replace(/,+$/, '') === 'Time';
    expect(v.warnings).toEqual(noVents ? ['no recognised columns found'] : []);
    expect(c.timesS.length).toBeGreaterThan(0);
    expect(v.timesS.length).toBe(c.timesS.length);
    expect(c.columns.length).toBeGreaterThan(0);
  });

  it.each(pairs)('wall vent net equals outflow minus inflow of the first compartment: $name', ({ vents }) => {
    const v = parseReferenceCsv(readFileSync(vents, 'utf8'), 'vents');
    const nets = v.columns.filter((c) => c.quantity === 'netInflow' && c.kind === 'wall');
    for (const net of nets) {
      const computed = ventNetOutflowOfFirst(v, net.entity, net.index);
      // A wall vent in the files always has its four layer columns.
      expect(computed, `${net.csvName} layer columns`).toBeDefined();
      for (let r = 0; r < net.values.length; r++) {
        const expected = net.values[r]!;
        expect(Math.abs(computed![r]! - expected), `${net.csvName} row ${r}`).toBeLessThanOrEqual(1e-9 + 1e-9 * Math.abs(expected));
      }
    }
  });

  it('Steckler_010 holds 180 data rows from 0 s to 1790 s in 10 s steps (not 181)', () => {
    const { c } = loadSteckler010();
    expect(c.timesS.length).toBe(180);
    expect(c.timesS[0]).toBe(0);
    expect(c.timesS[1]).toBe(10);
    expect(c.timesS[179]).toBeCloseTo(1790, 6);
  });

  it('Steckler_010 at 10 s matches the values in the design', () => {
    const { c, v } = loadSteckler010();
    const r = 1;
    expect(c.timesS[r]).toBe(10);
    const at = (q: Parameters<typeof findColumn>[1]['quantity'], layer?: 'upper' | 'lower', entity = 'Compartment 1') =>
      findColumn(c, { entity, quantity: q, ...(layer ? { layer } : {}) })!.values;
    expect(at('tempK', 'upper')[r]).toBeCloseTo(75.5362338415 + 273.15, 9);
    expect(at('tempRiseK', 'upper')[r]).toBeCloseTo(75.5362338415 - 26, 9);
    expect(at('tempK', 'lower')[r]).toBeCloseTo(26.7990546618 + 273.15, 9);
    expect(at('tempRiseK', 'upper')[0]).toBe(0);
    expect(at('layerHeightM')[r]).toBeCloseTo(1.33966272035, 11);
    expect(at('upperVolumeM3')[r]).toBeCloseTo(6.19624427247, 11);
    expect(at('pressurePa')[r]).toBeCloseTo(-0.0114569841463, 13);
    expect(at('hrrExpectedW', undefined, 'Steckler 62 kW')[r]).toBeCloseTo(62900, 6);
    expect(at('hrrW', undefined, 'Steckler 62 kW')[r]).toBeCloseTo(62900, 6);

    const get = (q: 'inflowUpper' | 'outflowUpper' | 'inflowLower' | 'outflowLower' | 'netInflow') =>
      findColumn(v, { entity: 'WallVent_1', quantity: q })!.values[r]!;
    expect(get('inflowUpper')).toBeCloseTo(7.25577550188e-7, 15);
    expect(get('outflowUpper')).toBeCloseTo(7.30484389067e-2, 12);
    expect(get('inflowLower')).toBeCloseTo(6.86858051049e-3, 12);
    expect(get('outflowLower')).toBeCloseTo(2.84053114651e-2, 12);
    // Net out of the room, 0.0946 kg/s, printed with a plus sign in the Net Inflow column.
    expect(get('netInflow')).toBeCloseTo(0.0946, 4);
    expect(ventNetOutflowOfFirst(v, 'WallVent_1', 1)![r]).toBeCloseTo(0.0946, 4);
  });

  it('returns warnings instead of throwing on malformed text', () => {
    expect(parseReferenceCsv('', 'vents').warnings.length).toBeGreaterThan(0);
    expect(parseReferenceCsv('a,b\n1,2\n', 'compartments').warnings.length).toBeGreaterThan(0);
  });
});

function findColumnByCsvName(table: ReferenceTable, csvName: string) {
  return table.columns.find((c) => c.csvName === csvName && c.quantity !== 'tempRiseK');
}

function loadSteckler010(): { c: ReferenceTable; v: ReferenceTable } {
  const base = join(REFERENCE_DIR, 'steckler', 'Steckler_010');
  return {
    c: parseReferenceCsv(readFileSync(`${base}_compartments.csv`, 'utf8'), 'compartments'),
    v: parseReferenceCsv(readFileSync(`${base}_vents.csv`, 'utf8'), 'vents'),
  };
}

function listCasePairs(): { name: string; comp: string; vents: string }[] {
  const out: { name: string; comp: string; vents: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('_compartments.csv')) {
        out.push({ name: e.name.replace('_compartments.csv', ''), comp: p, vents: p.replace('_compartments.csv', '_vents.csv') });
      }
    }
  };
  walk(REFERENCE_DIR);
  return out;
}
