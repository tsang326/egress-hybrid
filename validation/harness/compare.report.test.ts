// Tests for validation/harness/compare.ts and report.ts (fire-zone task 17.3; Requirements 13.4 to 13.6, 13.8, 13.10 to 13.12).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/core/fire/types';
import { compareRuns, compareWithReference, type CaseComparison, type RunDifference } from './compare';
import type { ReferenceColumn, ReferenceTable } from './referenceCsv';
import { PUBLISHED_STECKLER } from './published/steckler';
import { REFERENCE_STATEMENT, renderReport, type CaseResult } from './report';
import {
  COMPARE_START_TIME_S,
  INTERFACE_HEIGHT_ABS_TOL_M,
  RISE_ABS_TOL_K,
  RISE_REL_TOL,
  VENT_FLOW_ABS_TOL_KG_S,
  VENT_FLOW_REL_TOL,
} from './tolerances';

// ---------- fixtures: one compartment "C", one vent "V" ----------

type Kind = 'rise' | 'height' | 'flow';
const BASE_K = 300;

const f64 = (...v: number[]): Float64Array => Float64Array.from(v);

function col(entity: string, quantity: ReferenceColumn['quantity'], values: Float64Array, layer?: 'upper' | 'lower'): ReferenceColumn {
  return { entity, quantity, ...(layer === undefined ? {} : { layer }), index: 1, csvName: `${quantity}`, unit: '', values };
}

/** A model result and CFAST tables in which every quantity agrees except `kind`, which is ref vs mod at time `t`. */
function makeCase(kind: Kind, ref: number, mod: number, t: number): { result: Result; comp: ReferenceTable; vents: ReferenceTable } {
  const timesS = f64(0, t);
  const zero = f64(0, 0);
  const flows = { up: [0, 0], uo: [0, 0], lo: [0, 0], li: [0, 0] };
  let upperRise = [0, 0];
  let height = [1, 1];
  let refUpperRise = [0, 0];
  let refHeight = [1, 1];
  if (kind === 'rise') {
    upperRise = [0, mod];
    refUpperRise = [0, ref];
  } else if (kind === 'height') {
    height = [1, mod];
    refHeight = [1, ref];
  }
  const refFlowUpperIn = kind === 'flow' ? [0, ref] : [0, 0];
  if (kind === 'flow') flows.up = [0, mod];
  const result = {
    timesS,
    compartments: [
      {
        id: 'C',
        upperTempK: f64(...upperRise.map((r) => BASE_K + r)),
        lowerTempK: f64(BASE_K, BASE_K),
        interfaceHeightM: f64(...height),
      },
    ],
    vents: [
      {
        id: 'V',
        ends: [
          { compartmentId: 'C', upperInKgS: f64(...flows.up), upperOutKgS: zero, lowerInKgS: zero, lowerOutKgS: zero },
          { compartmentId: 'OUTSIDE', upperInKgS: zero, upperOutKgS: zero, lowerInKgS: zero, lowerOutKgS: zero },
        ],
      },
    ],
  } as unknown as Result;
  const comp: ReferenceTable = {
    timesS,
    warnings: [],
    columns: [
      col('C', 'tempRiseK', f64(...refUpperRise), 'upper'),
      col('C', 'tempRiseK', zero, 'lower'),
      col('C', 'layerHeightM', f64(...refHeight)),
    ],
  };
  const vt: ReferenceTable = {
    timesS,
    warnings: [],
    columns: [
      col('V', 'inflowUpper', f64(...refFlowUpperIn)),
      col('V', 'outflowUpper', zero),
      col('V', 'inflowLower', zero),
      col('V', 'outflowLower', zero),
    ],
  };
  return { result, comp, vents: vt };
}

// ---------- Property 28 ----------

describe('compareWithReference', () => {
  it('Property 28: comparator verdicts follow the tolerances', () => {
    // Feature: fire-zone, Property 28: Comparator verdicts follow the tolerances
    // **Validates: Requirements 13.4, 13.5, 13.6**
    // Values are multiples of 1/4 (Rise, flows scaled by 1/4) so that the model Rise (T - T0) is exact in floating point.
    const quarter = (lo: number, hi: number) => fc.integer({ min: lo * 4, max: hi * 4 }).map((n) => n / 4);
    const timeS = fc.oneof(fc.integer({ min: 1, max: 59 }), fc.constantFrom(59, 60, 61), fc.integer({ min: 60, max: 300 }));
    const scenario = fc.oneof(
      fc.record({
        kind: fc.constant<Kind>('rise'),
        ref: quarter(-50, 900),
        mod: quarter(-50, 900),
        allowed: fc.constant((r: number) => Math.max(RISE_REL_TOL * Math.abs(r), RISE_ABS_TOL_K)),
      }),
      fc.record({
        kind: fc.constant<Kind>('height'),
        ref: fc.integer({ min: 0, max: 400 }).map((n) => n / 100),
        mod: fc.integer({ min: 0, max: 400 }).map((n) => n / 100),
        allowed: fc.constant(() => INTERFACE_HEIGHT_ABS_TOL_M),
      }),
      fc.record({
        kind: fc.constant<Kind>('flow'),
        ref: fc.integer({ min: -2000, max: 2000 }).map((n) => n / 1000),
        mod: fc.integer({ min: -2000, max: 2000 }).map((n) => n / 1000),
        allowed: fc.constant((r: number) => Math.max(VENT_FLOW_REL_TOL * Math.abs(r), VENT_FLOW_ABS_TOL_KG_S)),
      }),
    );
    fc.assert(
      fc.property(scenario, timeS, ({ kind, ref, mod, allowed }, t) => {
        const { result, comp, vents } = makeCase(kind, ref, mod, t);
        const out = compareWithReference(result, comp, vents);
        const expectFail = t >= COMPARE_START_TIME_S && !(Math.abs(mod - ref) <= allowed(ref));
        // Req 13.4: nothing below 60 s is checked.
        if (t < COMPARE_START_TIME_S) {
          expect(out.failures).toHaveLength(0);
          expect(out.pointsChecked).toBe(0);
          expect(out.passed).toBe(false); // nothing compared is not a pass
          return;
        }
        expect(out.failures.length > 0).toBe(expectFail);
        expect(out.passed).toBe(!expectFail);
        // Req 13.6: a failure records quantity, time, both values and the difference.
        for (const f of out.failures) {
          expect(f.timeS).toBe(t);
          expect(f.cfastValue).toBe(ref);
          expect(f.difference).toBe(f.modelValue - f.cfastValue);
          expect(f.quantity.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('applies the 5 %/2 K, 0.10 m and 10 %/0.005 kg/s boundaries as stated', () => {
    const run = (kind: Kind, ref: number, mod: number) => {
      const c = makeCase(kind, ref, mod, 60);
      return compareWithReference(c.result, c.comp, c.vents).passed;
    };
    expect(run('rise', 100, 105)).toBe(true); // 5 % of 100 K
    expect(run('rise', 100, 105.5)).toBe(false);
    expect(run('rise', 10, 11.75)).toBe(true); // 2 K floor wins over 5 % of 10 K
    expect(run('rise', 10, 12.25)).toBe(false);
    expect(run('height', 1.5, 1.59)).toBe(true);
    expect(run('height', 1.5, 1.62)).toBe(false);
    expect(run('flow', 1, 1.09)).toBe(true);
    expect(run('flow', 1, 1.2)).toBe(false);
    expect(run('flow', 0.01, 0.0149)).toBe(true); // 0.005 kg/s floor wins over 10 % of 0.01
    expect(run('flow', 0.01, 0.016)).toBe(false);
  });

  it('treats a NaN model value as a failure', () => {
    const c = makeCase('height', 1, Number.NaN, 90);
    expect(compareWithReference(c.result, c.comp, c.vents).passed).toBe(false);
  });
});

describe('compareRuns', () => {
  it('reports no difference for identical runs and the largest difference otherwise', () => {
    const a = makeCase('rise', 100, 100, 90).result;
    const b = makeCase('rise', 100, 100, 90).result;
    expect(compareRuns(a, b).differs).toBe(false);
    const c = makeCase('rise', 100, 107, 90).result;
    const d = compareRuns(a, c);
    expect(d.differs).toBe(true);
    expect(d.largestAbsDifference).toBe(7);
    expect(d.timeS).toBe(90);
    expect(d.quantity).toBe('upper layer Rise (K)');
  });
});

// ---------- report ----------

const BANNED = /\b(safe|compliant|certified|passes|meets code)\b/i;

function comparison(failures: number): CaseComparison {
  return {
    passed: failures === 0,
    failures:
      failures === 0
        ? []
        : [{ quantity: 'upper layer Rise (K)', entity: 'C', timeS: 120, cfastValue: 100, modelValue: 130, difference: 30 }],
    summaries: [
      {
        quantity: 'upper layer Rise (K)',
        entity: 'C',
        pointsChecked: 10,
        failures,
        worstRatio: failures === 0 ? 0.5 : 6,
        worstTimeS: 120,
        worstCfastValue: 100,
        worstModelValue: failures === 0 ? 102 : 130,
      },
    ],
    missingModelTimesS: [],
    missingReference: [],
    pointsChecked: 10,
  };
}

const SAME: RunDifference = {
  differs: false,
  largestAbsDifference: 0,
  timeS: Number.NaN,
  quantity: '',
  entity: '',
  cfastOrderValue: Number.NaN,
  intendedOrderValue: Number.NaN,
};

const CASES: CaseResult[] = [
  { path: 'validation/cases/steckler/Steckler_010.in', verdict: 'outside tolerance', comparison: comparison(1), runDifference: SAME },
  {
    path: 'validation/cases/delco/Test_02.in',
    verdict: 'within tolerance',
    comparison: comparison(0),
    runDifference: { ...SAME, differs: true, largestAbsDifference: 3.5, timeS: 120, quantity: 'interface height (m)', entity: 'C', cfastOrderValue: 1, intendedOrderValue: 1.5 },
  },
  { path: 'validation/cases/x/Missing.in', verdict: 'unsupported', reason: 'unsupported: no such feature' },
];

describe('renderReport', () => {
  const text = renderReport(CASES);

  it('contains the reference-simulation statement and no banned word outside it', () => {
    expect(text).toContain(REFERENCE_STATEMENT);
    expect(text.split(REFERENCE_STATEMENT).join('')).not.toMatch(BANNED);
  });

  it('lists every case and the summary counts', () => {
    for (const c of CASES) expect(text).toContain(`### ${c.path}`);
    expect(text).toContain('| 1 | 1 | 1 | 3 |');
    expect(text).toContain('unsupported: no such feature');
    expect(text).toContain('<details>');
  });

  it('shows the digitised labels, page numbers and note for a Steckler case', () => {
    const rec = PUBLISHED_STECKLER.find((r) => r.test === 10);
    expect(rec).toBeDefined();
    expect(text).toContain('CFAST (Validation Guide, digitised)');
    expect(text).toContain('Measured (Validation Guide, digitised)');
    expect(text).toContain(`printed p. ${rec?.printedPage}, PDF p. ${rec?.pdfPage}`);
    expect(text).toContain('digitised from the vector plots');
  });

  it('shows n/a for a Steckler test with no published entry', () => {
    const t = renderReport([{ path: 'validation/cases/steckler/Steckler_999.in', verdict: 'unsupported', reason: 'x' }]);
    expect(t).toContain('| 999 | n/a | n/a | n/a |');
  });

  it('shows a non-zero plume-order difference and "no difference" when identical', () => {
    expect(text).toContain('Largest absolute difference: 3.5 in interface height (m) of C at 120 s');
    expect(text).toContain('no difference');
  });

  it('is deterministic and independent of input order', () => {
    expect(renderReport(CASES)).toBe(text);
    expect(renderReport([...CASES].reverse())).toBe(text);
  });
});
