// Step acceptance, rejection, Newton-failure reduction and the H_MIN failure (Requirements 9.2 to 9.6).
// The solver knows no physics: it receives a residual callback F(t, y, y') and the structure of its Jacobian.
// Wall profiles and species live outside y. The residual must treat them as read-only "current" data, so a
// rejected or failed step needs no restore here; the driver commits them only after `advance` returns ok.
import {
  H_INITIAL,
  H_MAX,
  H_MIN,
  NEWTON_FAIL_REDUCTION,
  RTOL,
  STEP_BDF2_OMEGA_MAX,
  STEP_GROWTH_MAX,
  STEP_GROWTH_MIN,
  STEP_HOLD_AFTER_NEWTON_FAIL,
  STEP_MAX_FACTOR,
  STEP_MIN_FACTOR,
  STEP_SAFETY,
} from '../constants';
import { bdfCoefficients, createHistory, errorConstant, fillBeta, predict, pushHistory, resetHistory } from './bdf';
import type { BdfHistory } from './bdf';
import type { JacobianSparsity, ResidualFn } from './jacobian';
import { createIterationMatrix, createNewtonWork, DEFAULT_NEWTON_PARAMS, newtonSolve, wrmsNorm } from './newton';
import type { NewtonParams } from './newton';

export interface SolverParams {
  rtol: number;
  hMin: number;
  hMax: number;
  hInitial: number;
  newtonFailReduction: number;
  stepSafety: number;
  stepMinFactor: number;
  stepMaxFactor: number;
  stepGrowthMax: number;
  stepGrowthMin: number;
  bdf2OmegaMax: number;
  stepHoldAfterNewtonFail: number;
  newton: NewtonParams;
}

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  rtol: RTOL,
  hMin: H_MIN,
  hMax: H_MAX,
  hInitial: H_INITIAL,
  newtonFailReduction: NEWTON_FAIL_REDUCTION,
  stepSafety: STEP_SAFETY,
  stepMinFactor: STEP_MIN_FACTOR,
  stepMaxFactor: STEP_MAX_FACTOR,
  stepGrowthMax: STEP_GROWTH_MAX,
  stepGrowthMin: STEP_GROWTH_MIN,
  bdf2OmegaMax: STEP_BDF2_OMEGA_MAX,
  stepHoldAfterNewtonFail: STEP_HOLD_AFTER_NEWTON_FAIL,
  newton: DEFAULT_NEWTON_PARAMS,
};

export interface SolverOptions {
  residual: ResidualFn;
  sparsity: JacobianSparsity;
  /** Absolute error tolerance per unknown. */
  atol: Float64Array;
  /** Smallest finite-difference perturbation per unknown. */
  deltaMin: Float64Array;
  /**
   * 1 for unknowns whose row has the form y'_i - f_i (unit coefficient on y'_i); 0 for algebraic rows.
   * Used to compute y' at a restart and to leave algebraic rows out of the error test. Default: all differential.
   */
  differential?: Uint8Array;
  params?: Partial<SolverParams>;
}

export interface SolverStats {
  steps: number;
  rejected: number;
  newtonIterations: number;
  newtonFailures: number;
  jacobians: number;
  residualEvals: number;
}

export type AdvanceFailure = 'h-min';

export type AdvanceResult =
  | { ok: true; t: number; h: number; order: 1 | 2 }
  | { ok: false; reason: AdvanceFailure; t: number; h: number };

export class ImplicitSolver {
  readonly n: number;
  readonly stats: SolverStats = {
    steps: 0,
    rejected: 0,
    newtonIterations: 0,
    newtonFailures: 0,
    jacobians: 0,
    residualEvals: 0,
  };
  /** Step proposed for the next attempt. */
  h: number;

  private readonly residual: ResidualFn;
  private readonly sparsity: JacobianSparsity;
  private readonly atol: Float64Array;
  private readonly deltaMin: Float64Array;
  private readonly differential: Uint8Array;
  private readonly p: SolverParams;
  private readonly hist: BdfHistory;
  private readonly matrix;
  private readonly nw;
  private readonly yTrial: Float64Array;
  private readonly yPred: Float64Array;
  private readonly beta: Float64Array;
  private readonly weights: Float64Array;
  private readonly errVec: Float64Array;
  private readonly ypNew: Float64Array;
  private readonly zero: Float64Array;
  private readonly f: Float64Array;
  /** Accepted steps left during which the step may not grow (set by a Newton failure cut). */
  private holdSteps = 0;

  constructor(opts: SolverOptions) {
    const n = opts.sparsity.n;
    this.n = n;
    this.residual = opts.residual;
    this.sparsity = opts.sparsity;
    this.atol = opts.atol;
    this.deltaMin = opts.deltaMin;
    this.differential = opts.differential ?? new Uint8Array(n).fill(1);
    this.p = { ...DEFAULT_SOLVER_PARAMS, ...opts.params };
    this.hist = createHistory(n);
    this.matrix = createIterationMatrix(n);
    this.nw = createNewtonWork(n);
    this.yTrial = new Float64Array(n);
    this.yPred = new Float64Array(n);
    this.beta = new Float64Array(n);
    this.weights = new Float64Array(n);
    this.errVec = new Float64Array(n);
    this.ypNew = new Float64Array(n);
    this.zero = new Float64Array(n);
    this.f = new Float64Array(n);
    this.h = this.p.hInitial;
  }

  /** Current accepted time. */
  get t(): number {
    return this.hist.t[0];
  }
  /** Current accepted state (a view; copy it if you keep it). */
  get y(): Float64Array {
    return this.hist.y[0];
  }
  /** y' at the current accepted time. */
  get yp(): Float64Array {
    return this.hist.yp;
  }

  /**
   * Start or restart at (t, y): drops the multistep history, so the next step is BDF1 with the initial step
   * (Requirement 4.6). y' is taken from the residual at y' = 0 for differential rows and set to 0 for algebraic rows.
   */
  restart(t: number, y: Float64Array): void {
    const n = this.n;
    this.residual(t, y, this.zero, this.f);
    this.stats.residualEvals++;
    const yp = this.ypNew;
    for (let i = 0; i < n; i++) {
      const v = this.differential[i] !== 0 ? -(this.f[i] as number) : 0;
      yp[i] = Number.isFinite(v) ? v : 0;
    }
    resetHistory(this.hist, t, y, yp);
    this.matrix.valid = false;
    this.holdSteps = 0;
    this.h = this.p.hInitial;
  }

  /**
   * Take one accepted step that ends at or before `tEnd`. The step is shortened to land exactly on `tEnd`
   * when needed; the step proposed for the next call is kept at its unshortened size. Rejected steps and
   * Newton failures are retried inside this call. `hMax` limits this call only (for example the species lag limit).
   * On failure the accepted state is unchanged.
   */
  advance(tEnd: number, hMax: number = Infinity): AdvanceResult {
    const p = this.p;
    const hist = this.hist;
    const t0 = hist.t[0];
    if (!(tEnd > t0)) return { ok: true, t: t0, h: 0, order: 1 };
    const limit = Math.min(hMax, p.hMax);
    let h = Math.min(this.h, limit);
    if (h < p.hMin) h = Math.min(p.hMin, tEnd - t0);

    for (;;) {
      const remaining = tEnd - t0;
      const landing = h >= remaining;
      const hStep = landing ? remaining : h;
      const tNew = landing ? tEnd : t0 + hStep;

      const coef = bdfCoefficients(hist, hStep, p.bdf2OmegaMax);
      fillBeta(hist, coef, this.beta);
      predict(hist, tNew, this.yPred);
      this.yTrial.set(this.yPred);
      const y0 = hist.y[0];
      for (let i = 0; i < this.n; i++) this.weights[i] = 1 / (p.rtol * Math.abs((y0[i] as number)) + (this.atol[i] as number));

      let outcome = this.solveNewton(tNew, coef.alpha0, false);
      if (!outcome.converged) {
        // Refresh the Jacobian and retry once at the same h before cutting the step. When the matrix was old, rebuild it
        // at the predictor. When it was already rebuilt in the failed call (at the predictor), rebuild it at the last
        // iterate instead, if that iterate is usable.
        const usable = outcome.reason !== 'non-finite' && outcome.reason !== 'singular' && this.yTrial.every(Number.isFinite);
        if (!outcome.matrixRebuilt) this.yTrial.set(this.yPred);
        if (!outcome.matrixRebuilt || usable) {
          this.matrix.valid = false;
          outcome = this.solveNewton(tNew, coef.alpha0, true);
        }
      }
      if (!outcome.converged) {
        this.stats.newtonFailures++;
        this.matrix.valid = false;
        this.holdSteps = p.stepHoldAfterNewtonFail;
        h = hStep * p.newtonFailReduction;
        if (h < p.hMin) return this.fail(h);
        continue;
      }

      // Error estimate from the corrector minus the predictor (Requirement 9.4).
      // Algebraic rows (wall surface temperatures, Eq. 2.9) are left out of the error test, as DASPK does with
      // info(16) = 1: they carry no y', so after a restart their predictor is the old value and any jump to the
      // consistent value would not shrink with h (a step-function HRR at t = 0 then drove h below H_MIN).
      // Newton still solves those rows to NEWTON_TOL.
      const c = errorConstant(hist, coef, hStep);
      for (let i = 0; i < this.n; i++) {
        this.errVec[i] = this.differential[i] !== 0 ? c * ((this.yTrial[i] as number) - (this.yPred[i] as number)) : 0;
      }
      const errNorm = wrmsNorm(this.errVec, this.weights);
      const exponent = 1 / (coef.order + 1);

      if (!(errNorm <= 1)) {
        this.stats.rejected++;
        this.matrix.valid = false; // refresh rule (c): after a rejected step
        const raw = Number.isFinite(errNorm) ? p.stepSafety * Math.pow(errNorm, -exponent) : 0;
        h = hStep * Math.min(p.stepMaxFactor, Math.max(p.stepMinFactor, raw));
        if (h < p.hMin) return this.fail(h);
        continue;
      }

      // Accepted.
      const ypNew = this.ypNew;
      for (let i = 0; i < this.n; i++) ypNew[i] = coef.alpha0 * (this.yTrial[i] as number) + (this.beta[i] as number);
      pushHistory(hist, tNew, this.yTrial, ypNew);
      this.stats.steps++;

      let factor = errNorm > 0 ? p.stepSafety * Math.pow(errNorm, -exponent) : p.stepGrowthMax;
      factor = Math.min(factor, p.stepGrowthMax);
      let next = factor >= p.stepGrowthMin ? hStep * factor : hStep;
      if (this.holdSteps > 0) {
        this.holdSteps--;
        next = Math.min(next, hStep); // no growth while holding after a Newton failure cut
      }
      if (landing && hStep < this.h) next = Math.max(next, this.h); // a shortened landing step says nothing about the proposed size
      this.h = Math.min(next, p.hMax);
      return { ok: true, t: tNew, h: hStep, order: coef.order };
    }
  }

  private solveNewton(tNew: number, alpha0: number, forceRefresh: boolean) {
    const outcome = newtonSolve({
      residual: this.residual,
      sparsity: this.sparsity,
      matrix: this.matrix,
      work: this.nw,
      deltaMin: this.deltaMin,
      weights: this.weights,
      t: tNew,
      alpha0,
      beta: this.beta,
      y: this.yTrial,
      forceRefresh,
      params: this.p.newton,
    });
    this.stats.newtonIterations += outcome.iterations;
    this.stats.residualEvals += outcome.residualEvals;
    if (outcome.matrixRebuilt) this.stats.jacobians++;
    return outcome;
  }

  private fail(h: number): AdvanceResult {
    this.h = Math.max(h, 0);
    return { ok: false, reason: 'h-min', t: this.hist.t[0], h };
  }
}
