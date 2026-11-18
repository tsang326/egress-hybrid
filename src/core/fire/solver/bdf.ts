// Variable-step BDF1/BDF2 formulas, polynomial predictor and local error constants.
// Design "Solver design / Time integration". Tech Ref appendix C describes DASSL (variable-order BDF);
// the formulas here are the standard variable-step BDF1/BDF2 and are ours, not a port of DASSL.

/** Last accepted points. Index 0 is the newest (t_n). `count` is how many are valid (1 to 3). */
export interface BdfHistory {
  count: number;
  t: [number, number, number];
  y: [Float64Array, Float64Array, Float64Array];
  /** y' at t_n. */
  yp: Float64Array;
}

export function createHistory(n: number): BdfHistory {
  return {
    count: 0,
    t: [0, 0, 0],
    y: [new Float64Array(n), new Float64Array(n), new Float64Array(n)],
    yp: new Float64Array(n),
  };
}

/** Start a new history at one point. This is the BDF1 restart used at events (Requirement 4.6). */
export function resetHistory(h: BdfHistory, t: number, y: Float64Array, yp: Float64Array): void {
  h.count = 1;
  h.t[0] = t;
  h.y[0].set(y);
  h.yp.set(yp);
}

/** Add an accepted point as the newest one, dropping the oldest when three are held. No allocation. */
export function pushHistory(h: BdfHistory, t: number, y: Float64Array, yp: Float64Array): void {
  const oldest = h.y[2];
  h.y[2] = h.y[1];
  h.y[1] = h.y[0];
  h.y[0] = oldest;
  h.t[2] = h.t[1];
  h.t[1] = h.t[0];
  h.t[0] = t;
  oldest.set(y);
  h.yp.set(yp);
  if (h.count < 3) h.count++;
}

export interface BdfCoefficients {
  order: 1 | 2;
  /** y'(n+1) = alpha0 y(n+1) + beta. */
  alpha0: number;
  /** Weights of y(n) and y(n-1) in beta (divided by h). */
  c1: number;
  c2: number;
}

/**
 * Coefficients for a step of size `h`. BDF2 needs two points and `omega = h / h_prev <= omegaMax`.
 * BDF1: y' = (y_{n+1} - y_n) / h.
 * BDF2: y' = [(1+2w)/(1+w) y_{n+1} - (1+w) y_n + w^2/(1+w) y_{n-1}] / h, w = h / h_prev.
 */
export function bdfCoefficients(hist: BdfHistory, h: number, omegaMax: number): BdfCoefficients {
  if (hist.count >= 2) {
    const omega = h / (hist.t[0] - hist.t[1]);
    if (omega <= omegaMax) {
      return {
        order: 2,
        alpha0: (1 + 2 * omega) / ((1 + omega) * h),
        c1: -(1 + omega) / h,
        c2: (omega * omega) / ((1 + omega) * h),
      };
    }
  }
  return { order: 1, alpha0: 1 / h, c1: -1 / h, c2: 0 };
}

/** beta = c1 y(n) + c2 y(n-1). */
export function fillBeta(hist: BdfHistory, c: BdfCoefficients, beta: Float64Array): void {
  const y0 = hist.y[0];
  const n = beta.length;
  if (c.order === 1) {
    for (let i = 0; i < n; i++) beta[i] = c.c1 * (y0[i] as number);
  } else {
    const y1 = hist.y[1];
    for (let i = 0; i < n; i++) beta[i] = c.c1 * (y0[i] as number) + c.c2 * (y1[i] as number);
  }
}

/**
 * Predictor at `tNew`. With three points it is the quadratic through them (Lagrange form).
 * With fewer it is the explicit Euler step y_n + (tNew - t_n) y'_n.
 */
export function predict(hist: BdfHistory, tNew: number, out: Float64Array): void {
  const n = out.length;
  const [t0, t1, t2] = hist.t;
  if (hist.count >= 3) {
    const l0 = ((tNew - t1) * (tNew - t2)) / ((t0 - t1) * (t0 - t2));
    const l1 = ((tNew - t0) * (tNew - t2)) / ((t1 - t0) * (t1 - t2));
    const l2 = ((tNew - t0) * (tNew - t1)) / ((t2 - t0) * (t2 - t1));
    const [y0, y1, y2] = hist.y;
    for (let i = 0; i < n; i++) out[i] = l0 * (y0[i] as number) + l1 * (y1[i] as number) + l2 * (y2[i] as number);
  } else {
    const dt = tNew - t0;
    const y0 = hist.y[0];
    for (let i = 0; i < n; i++) out[i] = (y0[i] as number) + dt * (hist.yp[i] as number);
  }
}

/**
 * Constant C in  error ~ C (y_corrector - y_predictor), derived by Taylor expansion (not read from the Tech Ref).
 * - BDF1 with the Euler predictor: corrector - exact = h^2/2 y'', predictor - exact = -h^2/2 y'', so C = 1/2.
 * - BDF1 with the quadratic predictor: the predictor is a higher order, so C = 1.
 * - BDF2 with the quadratic predictor, w = h / h1: corrector error E y''' with E = h^3 (1+w)^2 / (6 w (1+2w)),
 *   predictor error Q y''' with Q = h (h+h1) (h+h1+h2) / 6, so C = E / (E + Q). For equal steps C = 2/11.
 * - BDF2 with the Euler predictor (only two points yet): C = 1/2, which overestimates the error (safe side).
 */
export function errorConstant(hist: BdfHistory, c: BdfCoefficients, h: number): number {
  const quadratic = hist.count >= 3;
  if (c.order === 1) return quadratic ? 1 : 0.5;
  if (!quadratic) return 0.5;
  const h1 = hist.t[0] - hist.t[1];
  const h2 = hist.t[1] - hist.t[2];
  const w = h / h1;
  const e = (h * h * h * (1 + w) * (1 + w)) / (6 * w * (1 + 2 * w));
  const q = (h * (h + h1) * (h + h1 + h2)) / 6;
  return e / (e + q);
}
