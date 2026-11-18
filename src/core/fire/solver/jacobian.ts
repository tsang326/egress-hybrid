// Coloured forward-difference Jacobian of the residual F(t, y, y').
// Design "Solver design / Jacobian": columns whose affected rows are disjoint share one residual evaluation.
// Tech Ref appendix C: the iteration matrix is dF/dy + alpha0 dF/dy' (alpha0 = d y'/d y of the BDF formula).
// Typed-array reads use `as number`: indices are in range by construction and `noUncheckedIndexedAccess` is on.
import { JAC_PERTURB_RELATIVE } from '../constants';

/** Residual callback F(t, y, y') written into `out`. The solver knows no physics. */
export type ResidualFn = (t: number, y: Float64Array, yp: Float64Array, out: Float64Array) => void;

/** Which rows each column can change, and a column colouring in which same-colour columns share no row. */
export interface JacobianSparsity {
  readonly n: number;
  /** `rowsOfColumn[j]`: rows that depend on unknown j (including the diagonal). */
  readonly rowsOfColumn: Int32Array[];
  /** `colours[c]`: columns perturbed together. Every column appears in exactly one colour. */
  readonly colours: Int32Array[];
}

/** Greedy colouring in column order (fixed order, so deterministic). */
export function colourColumns(rowsOfColumn: Int32Array[], nRows: number): Int32Array[] {
  const used: Uint8Array[] = [];
  const members: number[][] = [];
  rowsOfColumn.forEach((rows, j) => {
    let colour = used.findIndex((u) => rows.every((r) => u[r] === 0));
    if (colour < 0) {
      colour = used.length;
      used.push(new Uint8Array(nRows));
      members.push([]);
    }
    const u = used[colour] as Uint8Array;
    rows.forEach((r) => {
      u[r] = 1;
    });
    (members[colour] as number[]).push(j);
  });
  return members.map((m) => Int32Array.from(m));
}

export function buildSparsity(rowsOfColumn: Int32Array[], nRows: number): JacobianSparsity {
  return { n: nRows, rowsOfColumn, colours: colourColumns(rowsOfColumn, nRows) };
}

/** Every column touches every row, so every column has its own colour. */
export function denseSparsity(n: number): JacobianSparsity {
  const all = Int32Array.from({ length: n }, (_, i) => i);
  return buildSparsity(Array.from({ length: n }, () => all), n);
}

export interface JacobianWork {
  yPert: Float64Array;
  ypPert: Float64Array;
  fPert: Float64Array;
  delta: Float64Array;
}

export function createJacobianWork(n: number): JacobianWork {
  return {
    yPert: new Float64Array(n),
    ypPert: new Float64Array(n),
    fPert: new Float64Array(n),
    delta: new Float64Array(n),
  };
}

/**
 * Fill `jac` (row-major n x n) with dF/dy + alpha0 dF/dy' by forward differences.
 * Perturbing y_j by d also perturbs y'_j by alpha0 d, which gives the total derivative of the BDF corrector.
 * `f0` is F at (t, y, yp). Returns the number of residual evaluations used (the number of colours).
 */
export function colouredJacobian(
  residual: ResidualFn,
  sparsity: JacobianSparsity,
  t: number,
  y: Float64Array,
  yp: Float64Array,
  alpha0: number,
  f0: Float64Array,
  deltaMin: Float64Array,
  jac: Float64Array,
  work: JacobianWork,
): number {
  const { n, colours, rowsOfColumn } = sparsity;
  const { yPert, ypPert, fPert, delta } = work;
  jac.fill(0);
  yPert.set(y);
  ypPert.set(yp);
  for (const cols of colours) {
    for (const j of cols) {
      const yj = y[j] as number;
      let d = Math.max(JAC_PERTURB_RELATIVE * Math.abs(yj), deltaMin[j] as number);
      d = yj + d - yj; // exactly representable step
      if (d === 0) d = JAC_PERTURB_RELATIVE;
      delta[j] = d;
      yPert[j] = yj + d;
      ypPert[j] = (yp[j] as number) + alpha0 * d;
    }
    residual(t, yPert, ypPert, fPert);
    for (const j of cols) {
      const inv = 1 / (delta[j] as number);
      for (const r of rowsOfColumn[j] as Int32Array) {
        jac[r * n + j] = ((fPert[r] as number) - (f0[r] as number)) * inv;
      }
      yPert[j] = y[j] as number;
      ypPert[j] = yp[j] as number;
    }
  }
  return colours.length;
}
