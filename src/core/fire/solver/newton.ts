// Modified Newton iteration for one implicit step: G(y) = F(t, y, alpha0 y + beta) = 0.
// The iteration matrix M = dF/dy + alpha0 dF/dy' is factored once and reused across iterations and steps.
// Refresh rules (design "Newton iteration"): slow convergence, alpha0 (proportional to 1/h) changed by more than
// JAC_REFRESH_H_RATIO, and after a rejected step (the caller invalidates the matrix).
import {
  JAC_REFRESH_H_RATIO,
  NEWTON_LS_ARMIJO,
  NEWTON_LS_MAX_BACKTRACKS,
  NEWTON_LS_REDUCTION,
  NEWTON_MAX_ITER,
  NEWTON_SLOW_RATIO,
  NEWTON_TOL,
} from '../constants';
import { colouredJacobian, createJacobianWork } from './jacobian';
import type { JacobianSparsity, JacobianWork, ResidualFn } from './jacobian';
import { luFactor, luSolve } from './linalg';

export interface IterationMatrix {
  readonly n: number;
  lu: Float64Array;
  piv: Int32Array;
  /** alpha0 used when the matrix was built. */
  alpha0: number;
  valid: boolean;
}

export function createIterationMatrix(n: number): IterationMatrix {
  return { n, lu: new Float64Array(n * n), piv: new Int32Array(n), alpha0: 0, valid: false };
}

export interface NewtonWork {
  g: Float64Array;
  dy: Float64Array;
  yp: Float64Array;
  /** Line-search trial residual, correction and point. */
  gT: Float64Array;
  dyT: Float64Array;
  yT: Float64Array;
  jac: JacobianWork;
}

export function createNewtonWork(n: number): NewtonWork {
  return {
    g: new Float64Array(n),
    dy: new Float64Array(n),
    yp: new Float64Array(n),
    gT: new Float64Array(n),
    dyT: new Float64Array(n),
    yT: new Float64Array(n),
    jac: createJacobianWork(n),
  };
}

export interface NewtonParams {
  tol: number;
  maxIter: number;
  slowRatio: number;
  refreshRatio: number;
  lsMaxBacktracks: number;
  lsReduction: number;
  lsArmijo: number;
}

export const DEFAULT_NEWTON_PARAMS: NewtonParams = {
  tol: NEWTON_TOL,
  maxIter: NEWTON_MAX_ITER,
  slowRatio: NEWTON_SLOW_RATIO,
  refreshRatio: JAC_REFRESH_H_RATIO,
  lsMaxBacktracks: NEWTON_LS_MAX_BACKTRACKS,
  lsReduction: NEWTON_LS_REDUCTION,
  lsArmijo: NEWTON_LS_ARMIJO,
};

export type NewtonFailure = 'max-iterations' | 'slow' | 'singular' | 'non-finite';

export interface NewtonOutcome {
  converged: boolean;
  reason: NewtonFailure | null;
  iterations: number;
  /** True when this call rebuilt the iteration matrix. A failed call with this flag false may be retried with a fresh matrix. */
  matrixRebuilt: boolean;
  residualEvals: number;
}

/** Weighted RMS norm: sqrt(mean((v_i w_i)^2)). */
export function wrmsNorm(v: Float64Array, w: Float64Array): number {
  const n = v.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = (v[i] as number) * (w[i] as number);
    s += x * x;
  }
  return Math.sqrt(s / n);
}

export interface NewtonArgs {
  residual: ResidualFn;
  sparsity: JacobianSparsity;
  matrix: IterationMatrix;
  work: NewtonWork;
  deltaMin: Float64Array;
  /** Weights 1 / (RTOL |y| + ATOL) that put the correction in units of the error tolerance. */
  weights: Float64Array;
  t: number;
  /** y'(n+1) = alpha0 y(n+1) + beta. */
  alpha0: number;
  beta: Float64Array;
  /** Initial guess on entry, solution on exit (also on failure: discard it). */
  y: Float64Array;
  /** Rebuild the iteration matrix at the first iterate even if it looks valid. */
  forceRefresh?: boolean;
  params?: NewtonParams;
}

/**
 * Solve one implicit step. The convergence test is on the weighted RMS norm of the Newton correction M^-1 G,
 * the residual expressed in solution units (as DASSL does), because the residual rows have different units.
 * The same norm is the merit function of a backtracking line search: a Newton step that does not reduce it is
 * shortened (numerical parameters NEWTON_LS_*), which stops the iteration from flipping between the two sides
 * of a kink in the residual (for example a vent flow near zero pressure difference).
 */
export function newtonSolve(args: NewtonArgs): NewtonOutcome {
  const { residual, sparsity, matrix, work, deltaMin, weights, t, alpha0, beta, y } = args;
  const p = args.params ?? DEFAULT_NEWTON_PARAMS;
  const n = y.length;
  const { g, dy, yp, gT, dyT, yT } = work;
  const out: NewtonOutcome = { converged: false, reason: null, iterations: 0, matrixRebuilt: false, residualEvals: 0 };
  let previous = Infinity;
  let previousDamped = false;
  let carried = false; // g and dy already hold the residual and correction at the current y (from the line search)
  let norm = 0;
  let forceRefresh = args.forceRefresh === true;

  for (let k = 1; k <= p.maxIter; k++) {
    out.iterations = k;
    if (!carried) {
      for (let i = 0; i < n; i++) yp[i] = alpha0 * (y[i] as number) + (beta[i] as number);
      residual(t, y, yp, g);
      out.residualEvals++;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(g[i])) {
          out.reason = 'non-finite';
          return out;
        }
      }

      if (forceRefresh || needsRefresh(matrix, alpha0, p.refreshRatio)) {
        forceRefresh = false;
        const evals = colouredJacobian(residual, sparsity, t, y, yp, alpha0, g, deltaMin, matrix.lu, work.jac);
        out.residualEvals += evals;
        out.matrixRebuilt = true;
        matrix.alpha0 = alpha0;
        matrix.valid = luFactor(matrix.lu, n, matrix.piv);
        if (!matrix.valid) {
          out.reason = 'singular';
          return out;
        }
      }

      for (let i = 0; i < n; i++) dy[i] = -(g[i] as number);
      luSolve(matrix.lu, matrix.piv, n, dy);
      norm = wrmsNorm(dy, weights);
    }
    carried = false;
    if (!Number.isFinite(norm)) {
      out.reason = 'non-finite';
      return out;
    }

    if (norm <= p.tol) {
      for (let i = 0; i < n; i++) y[i] = (y[i] as number) + (dy[i] as number);
      out.converged = true;
      return out;
    }
    if (k > 1 && !previousDamped && norm > p.slowRatio * previous) {
      for (let i = 0; i < n; i++) y[i] = (y[i] as number) + (dy[i] as number);
      out.reason = 'slow';
      return out;
    }
    previous = norm;

    // Backtracking line search on the norm of the Newton correction at the trial point.
    let lambda = 1;
    let accepted = false;
    for (let j = 0; j <= p.lsMaxBacktracks; j++) {
      for (let i = 0; i < n; i++) yT[i] = (y[i] as number) + lambda * (dy[i] as number);
      for (let i = 0; i < n; i++) yp[i] = alpha0 * (yT[i] as number) + (beta[i] as number);
      residual(t, yT, yp, gT);
      out.residualEvals++;
      let finite = true;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(gT[i])) {
          finite = false;
          break;
        }
      }
      if (finite) {
        for (let i = 0; i < n; i++) dyT[i] = -(gT[i] as number);
        luSolve(matrix.lu, matrix.piv, n, dyT);
        const normT = wrmsNorm(dyT, weights);
        if (Number.isFinite(normT) && normT <= (1 - p.lsArmijo * lambda) * norm) {
          accepted = true;
          break;
        }
        if (j === p.lsMaxBacktracks) break;
      } else if (j === p.lsMaxBacktracks) {
        break;
      }
      lambda *= p.lsReduction;
    }
    if (accepted) {
      y.set(yT);
      g.set(gT);
      dy.set(dyT);
      norm = wrmsNorm(dy, weights);
      carried = true;
      previousDamped = lambda < 1;
    } else {
      // No decrease found: take the full step, as plain modified Newton does, and let the slow-convergence test judge it.
      for (let i = 0; i < n; i++) y[i] = (y[i] as number) + (dy[i] as number);
      previousDamped = false;
    }
  }
  out.reason = 'max-iterations';
  return out;
}

function needsRefresh(matrix: IterationMatrix, alpha0: number, ratio: number): boolean {
  if (!matrix.valid) return true;
  const r = alpha0 / matrix.alpha0;
  return r > ratio || r < 1 / ratio;
}
