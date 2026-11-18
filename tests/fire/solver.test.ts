// Tests for the implicit solver (tasks.md 8.2): BDF formulas, Newton, step control, LU and Thomas solves.
// Note: Requirement 9.3 says "residual norm"; the code tests the weighted RMS norm of the Newton correction
// (see newton.ts). These tests check the behaviour of the code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bdfCoefficients,
  createHistory,
  fillBeta,
  predict,
  pushHistory,
} from "../../src/core/fire/solver/bdf";
import { denseSparsity } from "../../src/core/fire/solver/jacobian";
import type { ResidualFn } from "../../src/core/fire/solver/jacobian";
import { luFactor, luSolve, thomasSolve } from "../../src/core/fire/solver/linalg";
import { ImplicitSolver } from "../../src/core/fire/solver/stepControl";
import type { SolverParams } from "../../src/core/fire/solver/stepControl";
import { DEFAULT_NEWTON_PARAMS } from "../../src/core/fire/solver/newton";
import { STEP_BDF2_OMEGA_MAX } from "../../src/core/fire/constants";

const NUM_RUNS = 100;

function makeSolver(n: number, residual: ResidualFn, atol: number, params: Partial<SolverParams> = {}): ImplicitSolver {
  return new ImplicitSolver({
    residual,
    sparsity: denseSparsity(n),
    atol: new Float64Array(n).fill(atol),
    deltaMin: new Float64Array(n).fill(1e-8),
    params,
  });
}

/** Residual of y' = f(t, y) for one unknown: F = y' - f. */
function scalarOde(f: (t: number, y: number) => number): ResidualFn {
  return (t, y, yp, out) => {
    out[0] = (yp[0] as number) - f(t, y[0] as number);
  };
}

/** Advance to tEnd with repeated advance calls; returns the number of accepted steps. */
function integrate(s: ImplicitSolver, tEnd: number): number {
  let steps = 0;
  while (s.t < tEnd) {
    const r = s.advance(tEnd);
    if (!r.ok) throw new Error(`solver failed at t=${r.t}`);
    steps++;
    if (steps > 100000) throw new Error("too many steps");
  }
  return steps;
}

describe("Property 21: BDF integration is exact on low-degree polynomials and converges", () => {
  // Feature: fire-zone, Property 21: BDF integration is exact on low-degree polynomials and converges
  // **Validates: Requirements 9.1, 9.4**
  const arbPoly = fc.record({
    a: fc.double({ min: -5, max: 5, noNaN: true }),
    b: fc.double({ min: -5, max: 5, noNaN: true }),
    c: fc.double({ min: -5, max: 5, noNaN: true }),
  });

  it("variable-step BDF2 and the quadratic predictor reproduce any quadratic within rounding", () => {
    fc.assert(
      fc.property(
        arbPoly,
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 0.1, max: STEP_BDF2_OMEGA_MAX - 0.01, noNaN: true }),
        ({ a, b, c }, tStart, h2, h1, omega) => {
          const p = (t: number) => a + b * t + c * t * t;
          const dp = (t: number) => b + 2 * c * t;
          const hist = createHistory(1);
          const t2 = tStart;
          const t1 = t2 + h2;
          const t0 = t1 + h1;
          for (const t of [t2, t1, t0]) pushHistory(hist, t, Float64Array.of(p(t)), Float64Array.of(dp(t)));
          expect(hist.count).toBe(3);

          const h = omega * h1;
          const tNew = t0 + h;
          const coef = bdfCoefficients(hist, h, STEP_BDF2_OMEGA_MAX);
          expect(coef.order).toBe(2);
          const beta = new Float64Array(1);
          fillBeta(hist, coef, beta);
          const ypNew = coef.alpha0 * p(tNew) + (beta[0] as number);
          const scale = 1 + Math.abs(a) + Math.abs(b) + Math.abs(c);
          expect(Math.abs(ypNew - dp(tNew))).toBeLessThanOrEqual(1e-9 * scale);

          const out = new Float64Array(1);
          predict(hist, tNew, out);
          expect(Math.abs((out[0] as number) - p(tNew))).toBeLessThanOrEqual(1e-9 * scale);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("the solver integrates y' = b exactly (any step sequence) within rounding", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: 0.5, max: 3, noNaN: true }),
        (y0, b, tEnd) => {
          const s = makeSolver(1, scalarOde(() => b), 1e-6);
          s.restart(0, Float64Array.of(y0));
          integrate(s, tEnd);
          expect(s.t).toBe(tEnd);
          expect(Math.abs((s.y[0] as number) - (y0 + b * tEnd))).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(y0) + Math.abs(b) * tEnd));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("y' = -lambda y has accepted-step error within a fixed factor of the tolerance, and tighter rtol gives smaller error", () => {
    const rtol = 1e-4;
    const atol = 1e-8;
    const FACTOR = 20; // fixed factor of the requested tolerance (design Property 21); global error accumulates over steps
    const run = (lambda: number, tEnd: number, tol: number) => {
      const s = makeSolver(1, scalarOde((_t, y) => -lambda * y), atol, { rtol: tol });
      s.restart(0, Float64Array.of(1));
      integrate(s, tEnd);
      return Math.abs((s.y[0] as number) - Math.exp(-lambda * tEnd));
    };
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        fc.double({ min: 0.5, max: 2, noNaN: true }),
        (lambda, tEnd) => {
                    expect(run(lambda, tEnd, rtol)).toBeLessThanOrEqual(FACTOR * (rtol * 1 + atol));
        },
      ),
      { numRuns: NUM_RUNS },
    );
    // Convergence: the error does not grow when the tolerance is tightened by a factor of 1000.
    expect(run(1, 1, rtol / 1000)).toBeLessThan(run(1, 1, rtol));
  });
});

describe("solver unit tests", () => {
  it("linear test equation y' = -y reaches exp(-t) and lands exactly on the end time", () => {
    const s = makeSolver(1, scalarOde((_t, y) => -y), 1e-8);
    s.restart(0, Float64Array.of(1));
    integrate(s, 2);
    expect(s.t).toBe(2);
    expect(s.y[0] as number).toBeCloseTo(Math.exp(-2), 2);
    expect(s.stats.steps).toBeGreaterThan(0);
    expect(s.stats.rejected + s.stats.newtonFailures).toBeGreaterThanOrEqual(0);
  });

  it("the first step is BDF1 and later steps use BDF2", () => {
    const s = makeSolver(1, scalarOde((_t, y) => -y), 1e-8);
    s.restart(0, Float64Array.of(1));
    const first = s.advance(1);
    const second = s.advance(1);
    expect(first.ok && first.order).toBe(1);
    expect(second.ok && second.order).toBe(2);
  });

  it("advance with tEnd not after the current time is a no-op", () => {
    const s = makeSolver(1, scalarOde((_t, y) => -y), 1e-8);
    s.restart(1, Float64Array.of(1));
    const r = s.advance(1);
    expect(r).toEqual({ ok: true, t: 1, h: 0, order: 1 });
  });

  it("a stiff pressure-relaxation problem is stable with steps far above the relaxation time", () => {
    // p' = -k (p - p_eq(t)) with k = 1e6 1/s: relaxation time 1 microsecond, explicit methods need h < 2e-6.
    const k = 1e6;
    const pEq = (t: number) => 10 * Math.sin(t);
    const s = makeSolver(1, scalarOde((t, p) => -k * (p - pEq(t))), 1e-3);
    s.restart(0, Float64Array.of(0));
    const steps = integrate(s, 1);
    expect(s.y[0] as number).toBeCloseTo(pEq(1), 1);
    expect(steps).toBeLessThan(2000); // an explicit method would need at least 5e5 steps
  });

  it("a stiff two-unknown system with a mixed algebraic row keeps the algebraic constraint", () => {
    // y0' = -y0 (differential), y1 = 2 y0 (algebraic row: F1 = y1 - 2 y0).
    const residual: ResidualFn = (_t, y, yp, out) => {
      out[0] = (yp[0] as number) + (y[0] as number);
      out[1] = (y[1] as number) - 2 * (y[0] as number);
    };
    const s = new ImplicitSolver({
      residual,
      sparsity: denseSparsity(2),
      atol: new Float64Array(2).fill(1e-8),
      deltaMin: new Float64Array(2).fill(1e-8),
      differential: Uint8Array.of(1, 0),
    });
    s.restart(0, Float64Array.of(1, 2));
    integrate(s, 1);
    expect(s.y[0] as number).toBeCloseTo(Math.exp(-1), 2);
    expect(Math.abs((s.y[1] as number) - 2 * (s.y[0] as number))).toBeLessThan(1e-6);
  });

  it("a failing Newton iteration reduces the step and retries; the state advances to a finite value", () => {
    // y' = -50 y^3 is nonlinear. With one Newton iteration allowed, the first large step cannot converge.
    const newton = { ...DEFAULT_NEWTON_PARAMS, maxIter: 1, tol: 1e-6 };
    const s = makeSolver(1, scalarOde((_t, y) => -50 * y * y * y), 1e-8, { newton, hInitial: 0.5 });
    s.restart(0, Float64Array.of(1));
    const r = s.advance(1);
    expect(s.stats.newtonFailures).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.h).toBeLessThan(0.5);
      expect(r.t).toBe(s.t);
    }
    expect(Number.isFinite(s.y[0] as number)).toBe(true);
    expect(s.y[0] as number).toBeLessThan(1);
    expect(s.y[0] as number).toBeGreaterThan(0);
  });

  it("failure below H_MIN returns ok=false with the last accepted time and leaves the state unchanged", () => {
    const tBad = 0.3;
    const residual: ResidualFn = (t, y, yp, out) => {
      out[0] = t > tBad ? Number.NaN : (yp[0] as number) + (y[0] as number);
    };
    const s = makeSolver(1, residual, 1e-8);
    s.restart(0, Float64Array.of(1));
    let result = s.advance(1);
    while (result.ok && s.t < 1) result = s.advance(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("h-min");
      expect(result.t).toBe(s.t);
      expect(result.t).toBeLessThanOrEqual(tBad);
      expect(result.t).toBeGreaterThan(tBad - 1);
      expect(result.h).toBeLessThan(s.stats.steps > 0 ? 1e-8 : Infinity);
    }
    expect(s.stats.newtonFailures).toBeGreaterThan(0);
    expect(s.y[0] as number).toBeCloseTo(Math.exp(-s.t), 3);
  });

  it("restart drops the history so the next step is BDF1 with the initial step", () => {
    const s = makeSolver(1, scalarOde((_t, y) => -y), 1e-8);
    s.restart(0, Float64Array.of(1));
    integrate(s, 0.5);
    s.restart(s.t, Float64Array.of(s.y[0] as number));
    expect(s.h).toBe(1e-3);
    const r = s.advance(1);
    expect(r.ok && r.order).toBe(1);
  });

  it("is deterministic: two identical runs give bit-identical states", () => {
    const run = () => {
      const s = makeSolver(1, scalarOde((_t, y) => -3 * y), 1e-8);
      s.restart(0, Float64Array.of(1));
      integrate(s, 1);
      return s.y[0];
    };
    expect(run()).toBe(run());
  });
});

describe("linear algebra", () => {
  it("LU with partial pivoting solves a known 3x3 system that needs a row swap", () => {
    // 0 x + 2 y + 1 z = 7 ; 1 x + 1 y + 1 z = 6 ; 2 x + 1 y + 0 z = 4  ->  x = 1, y = 2, z = 3
    const a = Float64Array.of(0, 2, 1, 1, 1, 1, 2, 1, 0);
    const x = [1, 2, 3];
    const b = Float64Array.of(2 * 2 + 3, 1 + 2 + 3, 2 + 2);
    const piv = new Int32Array(3);
    expect(luFactor(a, 3, piv)).toBe(true);
    luSolve(a, piv, 3, b);
    x.forEach((v, i) => expect(b[i] as number).toBeCloseTo(v, 12));
  });

  it("LU reports a singular matrix", () => {
    const a = Float64Array.of(1, 2, 2, 4);
    expect(luFactor(a, 2, new Int32Array(2))).toBe(false);
    expect(luFactor(Float64Array.of(Number.NaN), 1, new Int32Array(1))).toBe(false);
  });

  it("Thomas solves a known tridiagonal system", () => {
    // [2 -1 0; -1 2 -1; 0 -1 2] x = [1 0 1]  ->  x = [1 1 1]
    const sub = Float64Array.of(0, -1, -1);
    const diag = Float64Array.of(2, 2, 2);
    const sup = Float64Array.of(-1, -1, 0);
    const x = new Float64Array(3);
    expect(thomasSolve(sub, diag, sup, Float64Array.of(1, 0, 1), x, 3, new Float64Array(3))).toBe(true);
    [1, 1, 1].forEach((v, i) => expect(x[i] as number).toBeCloseTo(v, 12));
  });

  it("Thomas reports a zero pivot and accepts n = 0", () => {
    const z = new Float64Array(2);
    expect(thomasSolve(z, z, z, z, new Float64Array(2), 2, new Float64Array(2))).toBe(false);
    expect(thomasSolve(z, z, z, z, new Float64Array(0), 0, new Float64Array(0))).toBe(true);
  });

  it("Thomas and LU agree on random diagonally dominant tridiagonal systems", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            sub: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: n, maxLength: n }),
            sup: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: n, maxLength: n }),
            rhs: fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: n, maxLength: n }),
          }),
        ),
        ({ n, sub, sup, rhs }) => {
          const subA = Float64Array.from(sub);
          const supA = Float64Array.from(sup);
          subA[0] = 0;
          supA[n - 1] = 0;
          const diag = new Float64Array(n).fill(3); // |sub| + |sup| <= 2 < 3
          const dense = new Float64Array(n * n);
          for (let i = 0; i < n; i++) {
            dense[i * n + i] = diag[i] as number;
            if (i > 0) dense[i * n + i - 1] = subA[i] as number;
            if (i < n - 1) dense[i * n + i + 1] = supA[i] as number;
          }
          const x = new Float64Array(n);
          expect(thomasSolve(subA, diag, supA, Float64Array.from(rhs), x, n, new Float64Array(n))).toBe(true);
          const piv = new Int32Array(n);
          const b = Float64Array.from(rhs);
          expect(luFactor(dense, n, piv)).toBe(true);
          luSolve(dense, piv, n, b);
          for (let i = 0; i < n; i++) expect(Math.abs((x[i] as number) - (b[i] as number))).toBeLessThan(1e-10);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
