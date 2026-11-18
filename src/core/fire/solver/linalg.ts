// Dense LU with partial pivoting and the Thomas algorithm.
// Numerical linear algebra, no physics. Tech Ref appendix C and 5.3 only name the methods; the code is ours.
// Fixed operation order and first-maximum pivot choice keep results bit-reproducible (Requirement 9.8).
// Typed-array reads use `as number`: indices are in range by construction and `noUncheckedIndexedAccess` is on.

/**
 * Factor the row-major n x n matrix `a` in place as P A = L U with partial pivoting.
 * L has a unit diagonal and is stored below the diagonal. `piv[k]` is the row swapped with row k at step k.
 * Returns false when a pivot is zero or not finite (the matrix is singular or holds NaN).
 */
export function luFactor(a: Float64Array, n: number, piv: Int32Array): boolean {
  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(a[k * n + k] as number);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k] as number);
      if (v > best) {
        best = v;
        p = i;
      }
    }
    piv[k] = p;
    if (!(best > 0) || !Number.isFinite(best)) return false;
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const tmp = a[k * n + j] as number;
        a[k * n + j] = a[p * n + j] as number;
        a[p * n + j] = tmp;
      }
    }
    const pivot = a[k * n + k] as number;
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] as number) / pivot;
      a[i * n + k] = f;
      if (f !== 0) {
        for (let j = k + 1; j < n; j++) a[i * n + j] = (a[i * n + j] as number) - f * (a[k * n + j] as number);
      }
    }
  }
  return true;
}

/** Solve A x = b with the factors from `luFactor`. `b` is overwritten with x. */
export function luSolve(lu: Float64Array, piv: Int32Array, n: number, b: Float64Array): void {
  for (let k = 0; k < n; k++) {
    const p = piv[k] as number;
    if (p !== k) {
      const tmp = b[k] as number;
      b[k] = b[p] as number;
      b[p] = tmp;
    }
  }
  for (let i = 1; i < n; i++) {
    let s = b[i] as number;
    for (let j = 0; j < i; j++) s -= (lu[i * n + j] as number) * (b[j] as number);
    b[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i] as number;
    for (let j = i + 1; j < n; j++) s -= (lu[i * n + j] as number) * (b[j] as number);
    b[i] = s / (lu[i * n + i] as number);
  }
}

/**
 * Thomas algorithm for a tridiagonal system. `sub[i]` multiplies x[i-1] in row i (`sub[0]` unused),
 * `diag[i]` multiplies x[i], `sup[i]` multiplies x[i+1] (`sup[n-1]` unused).
 * `work` has length n. `x` may be the same array as `rhs`. Inputs other than `x` and `work` are not changed.
 * Returns false when a pivot is zero or not finite.
 */
export function thomasSolve(
  sub: Float64Array,
  diag: Float64Array,
  sup: Float64Array,
  rhs: Float64Array,
  x: Float64Array,
  n: number,
  work: Float64Array,
): boolean {
  if (n === 0) return true;
  let denom = diag[0] as number;
  if (!(Math.abs(denom) > 0) || !Number.isFinite(denom)) return false;
  work[0] = (sup[0] as number) / denom;
  x[0] = (rhs[0] as number) / denom;
  for (let i = 1; i < n; i++) {
    denom = (diag[i] as number) - (sub[i] as number) * (work[i - 1] as number);
    if (!(Math.abs(denom) > 0) || !Number.isFinite(denom)) return false;
    work[i] = i < n - 1 ? (sup[i] as number) / denom : 0;
    x[i] = ((rhs[i] as number) - (sub[i] as number) * (x[i - 1] as number)) / denom;
  }
  for (let i = n - 2; i >= 0; i--) x[i] = (x[i] as number) - (work[i] as number) * (x[i + 1] as number);
  return true;
}
