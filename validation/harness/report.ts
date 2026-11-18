// Report_Generator (fire-zone Req 13.8, 13.10 to 13.12, 6.13). Node and test use only.
// `renderReport` is a pure function: same input, same string. The verdicts come from the harness; this module
// never reads tolerances and never changes a case result.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseComparison, RunDifference } from './compare';
import { PUBLISHED_STECKLER, type PublishedSteckerRecord } from './published/steckler';

/** Verdict words used in the report. They describe a comparison with CFAST, never a building. */
export type CaseVerdict = 'within tolerance' | 'outside tolerance' | 'unsupported';

/** One case as the Validation_Suite hands it over. */
export interface CaseResult {
  /** Path of the `.in` file relative to the repository root, with `/` separators. */
  readonly path: string;
  readonly verdict: CaseVerdict;
  /** Why the case is outside tolerance or unsupported when there is no comparison (missing reference, parser error, ...). */
  readonly reason?: string;
  /** Comparison of the CFAST-order run. Absent when the case never reached the comparison. */
  readonly comparison?: CaseComparison;
  /** CFAST-order run versus intended-order run. Absent when the second run did not happen. */
  readonly runDifference?: RunDifference;
}

/** Mandatory statement (Req 13.12). */
export const REFERENCE_STATEMENT =
  'This model is a reference simulation. Its results do not show that any building is safe or compliant.';

const NIST_STATEMENT =
  'CFAST is software of the National Institute of Standards and Technology (NIST). The input files under ' +
  '`validation/cases/` come from the NIST CFAST repository and the reference outputs under `validation/reference/` ' +
  'were produced by running NIST CFAST 7.7.7 on them. NIST is the source of all CFAST values in this report. ' +
  'The NIST software notice is kept in `validation/NIST-NOTICE.md`.';

const DIGITISED_NOTE =
  'The CFAST and measured values in the Steckler tables are digitised from the vector plots of the CFAST Validation ' +
  'Guide (Appendix C.17) by `tools/steckler/digitise.ts`. They are not printed in the Guide, carry a reading ' +
  'uncertainty of about 0.1 °C and 0.01 m, and are not a criterion for any verdict. Temperatures are absolute values ' +
  'in °C. The Guide does not state the time or averaging period of the profiles.';

/** Fixed number format: 5 significant digits, no locale. */
export function formatNumber(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return '0';
  return String(Number(x.toPrecision(5)));
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0; // code-unit order, independent of locale
}

function steckerTestOf(path: string): number | undefined {
  const m = /(?:^|\/)Steckler_(\d+)\.in$/i.exec(path);
  return m ? Number(m[1]) : undefined;
}

function pageText(r: PublishedSteckerRecord): string {
  return `printed p. ${r.printedPage}, PDF p. ${r.pdfPage}`;
}

function steckerSection(test: number): string[] {
  const rec = PUBLISHED_STECKLER.find((r) => r.test === test);
  const header = [
    'Test',
    'Quantity',
    'CFAST (Validation Guide, digitised)',
    'Measured (Validation Guide, digitised)',
  ];
  const rows = rec
    ? [
        [
          String(test),
          `${rec.quantity} (${rec.unit})`,
          `${formatNumber(rec.cfast)} ${rec.unit}, layer height ${formatNumber(rec.cfastLayerHeightM)} m (${pageText(rec)})`,
          `${formatNumber(rec.measured)} ${rec.unit} at ${formatNumber(rec.measuredMaxHeightM)} m (${pageText(rec)})`,
        ],
      ]
    : [[String(test), 'n/a', 'n/a', 'n/a']];
  return ['**Published Steckler values**', '', ...table(header, rows), '', `Note: ${DIGITISED_NOTE}`, ''];
}

function runDifferenceSection(d: RunDifference | undefined): string[] {
  const head = '**CFAST-order run versus intended-order run** (the verdict above is for the CFAST-order run)';
  if (!d) return [head, '', 'Not available: the second run did not take place.', ''];
  if (!d.differs) return [head, '', 'no difference', ''];
  return [
    head,
    '',
    `Largest absolute difference: ${formatNumber(d.largestAbsDifference)} in ${d.quantity} of ${d.entity} at ${formatNumber(d.timeS)} s ` +
      `(CFAST-order run ${formatNumber(d.cfastOrderValue)}, intended-order run ${formatNumber(d.intendedOrderValue)}).`,
    '',
  ];
}

function comparisonSection(c: CaseComparison): string[] {
  const out: string[] = [];
  const rows = c.summaries.map((s) => [
    s.entity,
    s.quantity,
    formatNumber(s.worstTimeS),
    formatNumber(s.worstCfastValue),
    formatNumber(s.worstModelValue),
    formatNumber(s.worstModelValue - s.worstCfastValue),
    String(s.pointsChecked),
    String(s.failures),
    s.failures === 0 ? 'within tolerance' : 'outside tolerance',
  ]);
  out.push(
    ...table(
      ['Entity', 'Quantity', 'Time (s)', 'CFAST value', 'Model value', 'Difference (model - CFAST)', 'Points checked', 'Points outside', 'Result'],
      rows,
    ),
    '',
    'Each row shows the time of the largest deviation from the allowed difference.',
    '',
  );
  if (c.missingModelTimesS.length > 0) {
    out.push(`Reference times with no model sample (s): ${c.missingModelTimesS.map(formatNumber).join(', ')}`, '');
  }
  if (c.missingReference.length > 0) {
    out.push('Model quantities with no reference column:', '', ...c.missingReference.map((m) => `- ${m}`), '');
  }
  if (c.failures.length > 0) {
    out.push(
      '<details>',
      `<summary>All ${c.failures.length} time points outside tolerance</summary>`,
      '',
      ...table(
        ['Entity', 'Quantity', 'Time (s)', 'CFAST value', 'Model value', 'Difference (model - CFAST)'],
        c.failures.map((f) => [f.entity, f.quantity, formatNumber(f.timeS), formatNumber(f.cfastValue), formatNumber(f.modelValue), formatNumber(f.difference)]),
      ),
      '',
      '</details>',
      '',
    );
  }
  return out;
}

function caseSection(r: CaseResult): string[] {
  const out = [`### ${r.path}`, '', `Result: **${r.verdict}**`, ''];
  if (r.reason) out.push(`Reason: ${r.reason}`, '');
  if (r.comparison) out.push(...comparisonSection(r.comparison));
  else out.push('No comparison with CFAST was made for this case.', '');
  out.push(...runDifferenceSection(r.runDifference));
  const test = steckerTestOf(r.path);
  if (test !== undefined) out.push(...steckerSection(test));
  return out;
}

/** Renders the whole report. Pure and deterministic; cases are sorted by path. */
export function renderReport(caseResults: readonly CaseResult[]): string {
  const cases = [...caseResults].sort((a, b) => comparePaths(a.path, b.path));
  const count = (v: CaseVerdict): number => cases.filter((c) => c.verdict === v).length;

  const lines: string[] = [
    '# Validation report: Fire_Model compared with CFAST 7.7.7',
    '',
    `> ${REFERENCE_STATEMENT}`,
    '',
    NIST_STATEMENT,
    '',
    'All cases are listed as they came out, including cases where the model differs from CFAST and cases where CFAST ' +
      'differs from the measurements. Nothing is left out or changed.',
    '',
    '## Summary',
    '',
    ...table(
      ['Within tolerance', 'Outside tolerance', 'Unsupported', 'Total'],
      [[String(count('within tolerance')), String(count('outside tolerance')), String(count('unsupported')), String(cases.length)]],
    ),
    '',
    ...table(
      ['Case', 'Result', 'Points checked', 'Points outside', 'Reason'],
      cases.map((c) => [
        c.path,
        c.verdict,
        c.comparison ? String(c.comparison.pointsChecked) : 'n/a',
        c.comparison ? String(c.comparison.failures.length) : 'n/a',
        c.reason ?? '',
      ]),
    ),
    '',
    '## Cases',
    '',
  ];
  for (const c of cases) lines.push(...caseSection(c));
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** Default output: `validation/REPORT.md` next to the harness directory. */
export const DEFAULT_REPORT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'REPORT.md');

/** Writes the report and returns its text. */
export function writeReport(caseResults: readonly CaseResult[], outPath: string = DEFAULT_REPORT_PATH): string {
  const text = renderReport(caseResults);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf8');
  return text;
}
