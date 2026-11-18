// Vent open fraction as a function of time. Pure functions, SI units (s).
import type { OpenFractionTable } from "../types";

// Requirements 4.3, 5.3, CFAST 7.7.7 source, flowhorizontal.f90 (wall_flow, get_vent_opening call): open fraction at time t.
// A number is a constant fraction. A table is piecewise linear between its entries and holds the first value before the
// first time and the last value after the last time. Never throws: a malformed table gives 1 for an empty table and
// uses the pairs that exist otherwise.
export function openFractionAt(open: number | OpenFractionTable, timeS: number): number {
  if (typeof open === "number") return open;
  const times = open.timesS;
  const fractions = open.fractions;
  const n = Math.min(times.length, fractions.length);
  if (n === 0) return 1;
  const first = times[0] as number;
  const last = times[n - 1] as number;
  if (!(timeS > first)) return fractions[0] as number;
  if (timeS >= last) return fractions[n - 1] as number;
  // Binary search for the interval [times[lo], times[lo + 1]] that holds timeS.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= timeS) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo] as number;
  const t1 = times[hi] as number;
  const f0 = fractions[lo] as number;
  const f1 = fractions[hi] as number;
  if (timeS === t0) return f0;
  return f0 + ((f1 - f0) * (timeS - t0)) / (t1 - t0);
}

// Requirement 4.6, 5.3: the times at which a table changes slope. The driver ends a step at each of them.
// A constant open fraction has none.
// Tech Ref 4.1 and CFAST 7.7.7 source, flowhorizontal.f90 (get_vent_opening): the open-fraction table is piecewise linear, so its slope changes only at the table times.
export function breakpoints(open: number | OpenFractionTable): number[] {
  if (typeof open === "number") return [];
  const n = Math.min(open.timesS.length, open.fractions.length);
  return open.timesS.slice(0, n);
}
