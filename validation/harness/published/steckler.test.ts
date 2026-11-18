// Task 15.3 (Requirements 13.10, 12.5): the generated Steckler table has the nine tests of design.md
// "Published Steckler values", flagged digitised, and the digitiser reproduces it byte for byte.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_STECKLER } from './steckler';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

// Door width (m) and burner position from Validation Guide Table 4.7 (printed page 78); page numbers and values
// from the design table.
const EXPECTED = [
  { test: 10, doorM: 0.24, burner: 'Centre', measured: 193.1, cfast: 156.3, pdf: 359, printed: 335 },
  { test: 12, doorM: 0.49, burner: 'Centre', measured: 142.0, cfast: 124.0, pdf: 359, printed: 335 },
  { test: 14, doorM: 0.74, burner: 'Centre', measured: 129.6, cfast: 120.3, pdf: 359, printed: 335 },
  { test: 17, doorM: 0.99, burner: 'Centre', measured: 109.7, cfast: 105.0, pdf: 360, printed: 336 },
  { test: 114, doorM: 0.24, burner: 'Back corner', measured: 250.8, cfast: 179.2, pdf: 361, printed: 337 },
  { test: 212, doorM: 0.49, burner: 'Back corner', measured: 195.6, cfast: 155.2, pdf: 361, printed: 337 },
  { test: 116, doorM: 0.99, burner: 'Back corner', measured: 172.1, cfast: 148.7, pdf: 362, printed: 338 },
  { test: 514, doorM: 0.24, burner: 'Back wall', measured: 211.0, cfast: 136.2, pdf: 363, printed: 339 },
  { test: 517, doorM: 0.99, burner: 'Back wall', measured: 134.7, cfast: 96.1, pdf: 363, printed: 339 },
] as const;

describe('published Steckler values', () => {
  it('has 9 digitised rows matching the design table', () => {
    expect(PUBLISHED_STECKLER).toHaveLength(9);
    for (const e of EXPECTED) {
      const row = PUBLISHED_STECKLER.find((r) => r.test === e.test);
      expect(row, `test ${e.test}`).toBeDefined();
      expect(row?.digitised).toBe(true);
      expect(row?.measured).toBe(e.measured);
      expect(row?.cfast).toBe(e.cfast);
      expect(row?.pdfPage).toBe(e.pdf);
      expect(row?.printedPage).toBe(e.printed);
    }
  });

  it('matches the door width and burner position of each case input (Table 4.7)', () => {
    // The published file does not store these; the case inputs do. Room is 2.8 m x 2.8 m, so position 1.4 is the
    // centre, a corner position sits near two walls and a wall position near one.
    for (const e of EXPECTED) {
      const name = `Steckler_${String(e.test).padStart(3, '0')}.in`;
      const text = readFileSync(join(repoRoot, 'validation/cases/steckler', name), 'utf8');
      const width = /&VENT[^/]*?WIDTH\s*=\s*([\d.]+)/s.exec(text)?.[1];
      expect(Number(width), `${name} door width`).toBe(e.doorM);
      const loc = /&FIRE[^/]*?LOCATION\s*=\s*([\d.]+)\s*,\s*([\d.]+)/s.exec(text);
      const x = Number(loc?.[1]);
      const y = Number(loc?.[2]);
      const nearWalls = [x, y].filter((v) => v !== 1.4).length;
      const expectedNear = e.burner === 'Centre' ? 0 : e.burner === 'Back wall' ? 1 : 2;
      expect(nearWalls, `${name} burner ${x},${y}`).toBe(expectedNear);
    }
  });

  it('is reproduced byte for byte by the digitiser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steckler-test-'));
    try {
      const out = join(dir, 'steckler.ts');
      const run = spawnSync('node', ['tools/steckler/digitise.ts', '--out', out], { cwd: repoRoot, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const committed = readFileSync(join(repoRoot, 'validation/harness/published/steckler.ts'));
      expect(Buffer.compare(readFileSync(out), committed)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
