// Tests for tools/steckler/digitise.ts (spec fire-zone, task 15.2, Requirement 13.10).
// The fixture tests/fixtures/steckler/synthetic-plot.svg is our own drawing. It holds no Guide content. It has its
// own glyph outlines, so the tests pass a glyph table built from those outlines to parseSvg.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  analysePlot,
  fitAxis,
  hashGlyph,
  parseMatrix,
  parsePathPoints,
  parseSvg,
  renderModule,
  roundTo,
  splitPlots,
  toRecord,
  type TestPage,
} from '../tools/steckler/digitise';

const ROOT = resolve(__dirname, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/steckler/synthetic-plot.svg');
const svg = readFileSync(FIXTURE, 'utf8');

// Fixture glyph i of '0123456789.' has the outline `M 0 0 L 1 {i+1} Z`.
const FIXTURE_GLYPHS: Record<string, string> = Object.fromEntries(
  [...'0123456789.'].map((c, i) => [hashGlyph(`M 0 0 L 1 ${i + 1} Z`), c]),
);

describe('fitAxis', () => {
  it('recovers a known line and reports no residual', () => {
    const fit = fitAxis([0, 100, 200, 300].map((v, i) => ({ coord: 100 + 50 * i, value: v })));
    expect(fit?.slope).toBeCloseTo(2, 12);
    expect(fit?.intercept).toBeCloseTo(-200, 9);
    expect(fit?.convert(175)).toBeCloseTo(150, 9);
    expect(fit?.span).toBe(300);
    expect(fit?.residualFraction).toBeLessThan(1e-12);
  });

  it('returns null for fewer than two ticks or ticks at one position', () => {
    expect(fitAxis([{ coord: 1, value: 1 }])).toBeNull();
    expect(fitAxis([{ coord: 1, value: 1 }, { coord: 1, value: 2 }])).toBeNull();
  });

  it('shows a large residual when a tick label is wrong', () => {
    const fit = fitAxis([
      { coord: 0, value: 0 },
      { coord: 10, value: 10 },
      { coord: 20, value: 20 },
      { coord: 30, value: 45 },
    ]);
    expect(fit?.residualFraction).toBeGreaterThan(0.005);
  });

  /** **Validates: Requirements 13.10** */
  it('property: any exact line through at least 3 ticks is recovered', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }).filter((s) => Math.abs(s) > 0.01),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.integer({ min: 3, max: 8 }),
        (slope, intercept, n) => {
          const ticks = Array.from({ length: n }, (_, i) => ({ coord: 10 * i, value: slope * 10 * i + intercept }));
          const fit = fitAxis(ticks);
          expect(fit).not.toBeNull();
          expect(fit?.residualFraction ?? 1).toBeLessThan(1e-9);
          expect(fit?.convert(25)).toBeCloseTo(slope * 25 + intercept, 6);
        },
      ),
    );
  });
});

describe('path and matrix scanners', () => {
  it('reads absolute M, L, C and Z commands', () => {
    expect(parsePathPoints('M 1 2 L 3 4 Z')).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(parsePathPoints('M 0 0 C 1 1 2 2 3 3')).toHaveLength(4);
  });

  it('returns null for relative commands, arcs and incomplete coordinates', () => {
    expect(parsePathPoints('m 1 2 l 3 4')).toBeNull();
    expect(parsePathPoints('M 0 0 A 1 1 0 0 0 2 2')).toBeNull();
    expect(parsePathPoints('M 1 2 L 3')).toBeNull();
  });

  it('parses matrix() and rejects other transforms', () => {
    expect(parseMatrix(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseMatrix('matrix(1, 0, 0, -1, 5, 6)')).toEqual([1, 0, 0, -1, 5, 6]);
    expect(parseMatrix('rotate(90)')).toBeNull();
    expect(parseMatrix('matrix(1 2 3)')).toBeNull();
  });
});

describe('parseSvg on the synthetic fixture', () => {
  const scene = parseSvg(svg, FIXTURE_GLYPHS);

  it('decodes labels with the supplied glyph table', () => {
    const texts = scene.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    for (const label of ['0', '100', '200', '300', '0.5', '1.0', '1.5', '2.0']) expect(texts).toContain(label);
    expect(texts.some((t) => t.endsWith(' 10') && t.length === 25)).toBe(true);
  });

  it('decodes unknown glyphs as "?" and does not read text from glyph definitions', () => {
    const plain = parseSvg(svg, {});
    const texts = plain.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    expect(texts).toContain('?');
    expect(texts.every((t) => !/\d/.test(t.replace(/\?/g, '')) || t.endsWith(' ??'))).toBe(true);
  });

  it('never evaluates or fails on junk', () => {
    expect(() => parseSvg('<svg><path d="M 1 <script>alert(1)</script>"/></svg>', {})).not.toThrow();
    expect(parseSvg('', {}).items).toEqual([]);
  });

  it('splits the page into one plot', () => {
    expect(splitPlots(scene)).toHaveLength(1);
    const two = { items: [...scene.items, ...scene.items] };
    expect(splitPlots(two)).toHaveLength(2);
  });
});

describe('analysePlot on the synthetic fixture', () => {
  const plot = splitPlots(parseSvg(svg, FIXTURE_GLYPHS))[0] ?? [];
  const reading = analysePlot(plot);

  it('passes every self-check', () => {
    expect(reading.problems).toEqual([]);
    expect(reading.test).toBe(10);
    expect(reading.xTicks).toBe(4);
    expect(reading.yTicks).toBe(4);
    expect(reading.measuredCount).toBe(19); // the marker in the legend box is not counted
  });

  it('fits both axes from the tick marks', () => {
    expect(reading.xFit?.convert(150)).toBeCloseTo(100, 6);
    expect(reading.yFit?.convert(150)).toBeCloseTo(1, 6);
    expect(reading.xFit?.residualFraction).toBeLessThan(0.005);
  });

  it('reads the measured maximum and the CFAST line', () => {
    expect(reading.measuredMax?.tempC).toBeCloseTo(290, 3);
    expect(reading.measuredMax?.heightM).toBeCloseTo(1.9, 3);
    expect(reading.cfast?.tempC).toBeCloseTo(180, 3);
    expect(reading.cfast?.layerHeightM).toBeCloseTo(1.2, 3);
  });

  it('reports a problem when a measured point is missing', () => {
    const dropped = plot.filter((it, i) => i !== plot.findIndex((x) => x.kind === 'path' && x.attrs.fill === 'rgb(0%, 0%, 0%)'));
    const r = analysePlot(dropped);
    expect(r.problems.some((p) => p.includes('18 measured points, expected 19'))).toBe(true);
    expect(r.measuredMax).toBeNull();
  });

  it('reports a problem when tick labels cannot be read', () => {
    const r = analysePlot(splitPlots(parseSvg(svg, {}))[0] ?? []);
    expect(r.problems.some((p) => p.includes('labelled ticks'))).toBe(true);
    expect(r.measuredMax).toBeNull();
  });
});

describe('rounding and output', () => {
  const page: TestPage = { test: 10, pdfPage: 359, printedPage: 335 };

  it('rounds to 0.1 °C and 0.01 m', () => {
    expect(roundTo(289.96, 0.1)).toBe(290);
    expect(roundTo(180.04, 0.1)).toBe(180);
    expect(roundTo(1.2049, 0.01)).toBe(1.2);
    expect(roundTo(-0.0001, 0.01)).toBe(0);
  });

  it('builds a digitised record and a deterministic module with the required header words', () => {
    const reading = analysePlot(splitPlots(parseSvg(svg, FIXTURE_GLYPHS))[0] ?? []);
    const rec = toRecord(page, reading);
    expect(rec).toMatchObject({ test: 10, cfast: 180, measured: 290, cfastLayerHeightM: 1.2, measuredMaxHeightM: 1.9, digitised: true });
    const a = renderModule(rec ? [rec] : [], { pdf: 'x.pdf', poppler: '1.2.3' });
    expect(a).toBe(renderModule(rec ? [rec] : [], { pdf: 'x.pdf', poppler: '1.2.3' }));
    expect(a).toContain('tools/steckler/digitise.ts');
    expect(a).toContain('digitised, not printed in the Guide');
    expect(a).toContain('poppler 1.2.3');
    expect(a).toContain('digitised: true');
  });

  it('gives no record when nothing was read', () => {
    expect(toRecord(page, analysePlot([]))).toBeNull();
  });
});

describe('command line self-check', () => {
  it('aborts without writing when the self-checks fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digitise-test-'));
    try {
      // A stand-in pdftocairo that "renders" the synthetic fixture. The real glyph table does not know the fixture's
      // glyphs, so no tick label can be read and the self-checks must fail.
      const fake = join(dir, 'pdftocairo');
      writeFileSync(
        fake,
        `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "pdftocairo version 0.0.0-test" >&2; exit 0; fi\n` +
          `for last; do :; done\ncp '${FIXTURE}' "$last"\n`,
      );
      chmodSync(fake, 0o755);
      const out = join(dir, 'steckler.ts');
      const run = spawnSync(
        process.execPath,
        [join(ROOT, 'tools/steckler/digitise.ts'), join(dir, 'unused.pdf'), '--out', out],
        { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('self-check failed, nothing written');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
