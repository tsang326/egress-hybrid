// Static checks and PRNG property for the fire-zone spec (task 1.3).
// Requirements 3.8, 3.9, 9.7, 11.2, 11.3.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createPrng } from '../../src/core/fire/prng';

const ROOT = process.cwd();
const FIRE_DIR = join(ROOT, 'src/core/fire');

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out.sort();
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

/** Text of the contiguous comment block (// lines or a block comment) directly above line `i`. */
function commentAbove(src: string[], i: number): string {
  const block: string[] = [];
  let j = i - 1;
  while (j >= 0) {
    const t = src[j]!.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/')) {
      block.unshift(t);
      j--;
    } else break;
  }
  return block.join('\n');
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

describe('Property 25: Seeded generator', () => {
  // Feature: fire-zone, Property 25: Seeded generator
  // **Validates: Requirements 11.3**
  it('same seed gives the same first 1,000 values, all in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2147483648, max: 4294967295 }), (seed) => {
        const a = createPrng(seed);
        const b = createPrng(seed);
        for (let i = 0; i < 1000; i++) {
          const x = a();
          const y = b();
          if (!Object.is(x, y) || x < 0 || x >= 1) return false;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('static checks of src/core/fire', () => {
  const files = listTs(FIRE_DIR);

  it('finds the module files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no Math.random (Req 11.2)', () => {
    const offenders = files.filter((f) => /Math\s*\.\s*random|Math\s*\[\s*['"]random['"]\s*\]/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('gives every constants.ts entry a source comment (Req 3.9)', () => {
    const path = join(FIRE_DIR, 'constants.ts');
    const src = lines(path);
    const SOURCE = /Tech Ref|CFAST 7\.7\.7|NIST|FDS User's Guide|numerical parameter, not from Tech Ref/;
    const missing: string[] = [];
    let count = 0;
    src.forEach((line, i) => {
      const m = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/.exec(line);
      if (!m) return;
      count++;
      if (!SOURCE.test(commentAbove(src, i))) missing.push(m[1]!);
    });
    expect(count).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('gives every exported physics function a source comment (Req 3.8)', () => {
    const PHYSICS_DIRS = ['gas', 'fire', 'vents', 'heat', 'species'];
    const physicsFiles = PHYSICS_DIRS.flatMap((d) => listTs(join(FIRE_DIR, d)));
    const SOURCE = /Tech Ref|NIST|CFAST 7\.7\.7 source/;
    const missing: string[] = [];
    for (const f of physicsFiles) {
      const src = lines(f);
      src.forEach((line, i) => {
        const m =
          /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)/.exec(line) ??
          /^export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z0-9_]+\s*=>)/.exec(line);
        if (!m) return;
        if (!SOURCE.test(commentAbove(src, i))) missing.push(`${relative(ROOT, f)}:${m[1]}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it('has no runtime dependencies in package.json (Req 9.7)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    const deps = pkg['dependencies'];
    expect(deps === undefined || Object.keys(deps as object).length === 0).toBe(true);
  });

  it('uses none of the banned words in warnings.ts messages', () => {
    const text = readFileSync(join(FIRE_DIR, 'validate/warnings.ts'), 'utf8');
    // Every string and template literal in the file, comments removed.
    const code = stripComments(text);
    const literals = code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    const BANNED = /\b(safe|compliant|certified|passes|meets code)\b/i;
    expect(literals.filter((s) => BANNED.test(s))).toEqual([]);
  });
});
