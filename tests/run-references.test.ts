// Tests for tools/cfast/run-references.sh using stub binaries (Requirements 12.1, 12.2, 12.8).
// Everything happens in temp directories; the real validation/reference is never touched.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve(__dirname, '../tools/cfast/run-references.sh');

let tmp: string;
let casesDir: string;
let refDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-refs-'));
  casesDir = join(tmp, 'cases');
  refDir = join(tmp, 'reference');
  mkdirSync(join(casesDir, 'a'), { recursive: true });
  mkdirSync(join(casesDir, 'b'), { recursive: true });
  for (const rel of ['a/one', 'a/two', 'b/three']) writeFileSync(join(casesDir, `${rel}.in`), '&HEAD VERSION=7770 /\n');
  mkdirSync(join(refDir, 'a'), { recursive: true });
  writeFileSync(join(refDir, 'a/one_compartments.csv'), 'old\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes an executable stub. `perCase` is shell text placed in the case branch, with $name set to the case name. */
function stub(revisionLine: string, perCase: string): string {
  const path = join(tmp, 'cfast-stub');
  writeFileSync(
    path,
    `#!/bin/bash
if [ "$#" -eq 0 ]; then
  echo "${revisionLine}"
  exit 0
fi
name="$(basename "$1" .in)"
${perCase}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const GOOD_CASE = `echo x > "\${name}_compartments.csv"; echo y > "\${name}_vents.csv"`;
const GOOD_REV = 'Revision         : CFAST-7.7.7-0-gb43e74e-HEAD';

function run(env: Record<string, string | undefined>) {
  const r = spawnSync('bash', [script], {
    env: {
      PATH: process.env.PATH,
      CFAST_CASES_DIR: casesDir,
      CFAST_REFERENCE_DIR: refDir,
      CFAST_CASE_TIMEOUT_S: '2',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
      else result[`${prefix}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  walk(dir, '');
  return result;
}

describe('run-references.sh', () => {
  it('exits 2 when CFAST is unset and leaves the reference dir unchanged', () => {
    const before = snapshot(refDir);
    const r = run({});
    expect(r.code).toBe(2);
    expect(r.out).toContain('set CFAST');
    expect(snapshot(refDir)).toEqual(before);
  });

  it('exits 2 when the binary does not exist', () => {
    const before = snapshot(refDir);
    const r = run({ CFAST: join(tmp, 'missing') });
    expect(r.code).toBe(2);
    expect(r.out).toContain('not found');
    expect(snapshot(refDir)).toEqual(before);
  });

  it('exits 2 when the file is not executable', () => {
    const path = join(tmp, 'plain');
    writeFileSync(path, '#!/bin/bash\n');
    chmodSync(path, 0o644);
    const r = run({ CFAST: path });
    expect(r.code).toBe(2);
    expect(r.out).toContain('not an executable file');
  });

  it('exits 3 on the wrong version and leaves the reference dir unchanged', () => {
    const before = snapshot(refDir);
    const r = run({ CFAST: stub('Revision         : CFAST-7.6.0-0-gabcdef-HEAD', GOOD_CASE) });
    expect(r.code).toBe(3);
    expect(r.out).toContain('CFAST 7.7.7 required');
    expect(r.out).toContain('CFAST-7.6.0');
    expect(r.out).not.toContain('Cases run');
    expect(snapshot(refDir)).toEqual(before);
  });

  it('runs every case with a good stub and copies both CSV files', () => {
    const r = run({ CFAST: stub(GOOD_REV, GOOD_CASE) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Using Revision');
    expect(r.out).toContain('Cases run: 3, failed: 0');
    for (const rel of ['a/one', 'a/two', 'b/three']) {
      expect(existsSync(join(refDir, `${rel}_compartments.csv`))).toBe(true);
      expect(existsSync(join(refDir, `${rel}_vents.csv`))).toBe(true);
    }
    expect(readFileSync(join(refDir, 'a/one_compartments.csv'), 'utf8')).toBe('x\n');
  });

  it('reports a failing case, runs the rest, and exits 1', () => {
    const perCase = `if [ "$name" = two ]; then echo boom >&2; exit 7; fi\n${GOOD_CASE}`;
    const r = run({ CFAST: stub(GOOD_REV, perCase) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED: a/two: CFAST exited with code 7');
    expect(r.out).toContain('Cases run: 3, failed: 1');
    expect(existsSync(join(refDir, 'a/two_compartments.csv'))).toBe(false);
    expect(existsSync(join(refDir, 'b/three_vents.csv'))).toBe(true);
    expect(existsSync(join(refDir, 'a/one_vents.csv'))).toBe(true);
  });

  it('times out a hanging case, runs the rest, and exits 1', () => {
    const perCase = `if [ "$name" = one ]; then exec sleep 30; fi\n${GOOD_CASE}`;
    const r = run({ CFAST: stub(GOOD_REV, perCase), CFAST_CASE_TIMEOUT_S: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED: a/one: timed out after 1 s');
    expect(r.out).toContain('Cases run: 3, failed: 1');
    expect(existsSync(join(refDir, 'a/two_vents.csv'))).toBe(true);
    expect(existsSync(join(refDir, 'b/three_vents.csv'))).toBe(true);
    // The old reference file for the timed-out case is not replaced.
    expect(readFileSync(join(refDir, 'a/one_compartments.csv'), 'utf8')).toBe('old\n');
    expect(existsSync(join(refDir, 'a/one_vents.csv'))).toBe(false);
  });

  it('reports a missing CSV and copies nothing for that case', () => {
    const perCase = `if [ "$name" = three ]; then echo x > "\${name}_compartments.csv"; exit 0; fi\n${GOOD_CASE}`;
    const r = run({ CFAST: stub(GOOD_REV, perCase) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED: b/three: missing output CSV');
    expect(existsSync(join(refDir, 'b'))).toBe(false);
    expect(existsSync(join(refDir, 'a/two_vents.csv'))).toBe(true);
  });
});
