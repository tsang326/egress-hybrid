// Configuration (view) factors between the four surfaces of a compartment: ceiling, upper wall, lower wall, floor.
// Index order everywhere in heat/: 0 ceiling, 1 upper wall, 2 lower wall, 3 floor.
// Sources: Tech Ref eq. 5.14 to 5.18 and the algebra after eq. 5.18; CFAST 7.7.7 source, radiation.f90 (rad4, rdparfig).

export interface ConfigurationFactors {
  areasM2: number[]; // surface areas, order ceiling, upper wall, lower wall, floor
  factors: number[]; // 4 x 4 row-major, factors[4 k + j] = F(k -> j)
}

// Tech Ref eq. 5.14: configuration factor between two identical, parallel, directly opposed rectangles
// of size x by y, a distance z apart. Returns 0 for a zero dimension (CFAST 7.7.7 source, radiation.f90, rdparfig).
export function parallelPlateFactor(x: number, y: number, z: number): number {
  if (!(x > 0) || !(y > 0) || !(z > 0)) return 0;
  const xx = x / z;
  const yy = y / z;
  const f1 = 0.5 * Math.log(((1 + xx * xx) * (1 + yy * yy)) / (1 + xx * xx + yy * yy));
  const ysq = Math.sqrt(1 + yy * yy);
  const f2 = xx * ysq * Math.atan(xx / ysq);
  const xsq = Math.sqrt(1 + xx * xx);
  const f3 = yy * xsq * Math.atan(yy / xsq);
  const f4 = xx * Math.atan(xx);
  const f5 = yy * Math.atan(yy);
  return (2 * (f1 + f2 + f3 - f4 - f5)) / (Math.PI * xx * yy);
}

// Tech Ref eq. 5.15 to 5.18 and the algebra after eq. 5.18; CFAST 7.7.7 source, radiation.f90 (rad4).
// Three base factors (ceiling to floor F1-4, ceiling to the layer plane F1-d, floor to the layer plane F4-d)
// plus reciprocity (A_i F_ij = A_j F_ji) and the enclosure sum (each row adds to 1) give all 16 factors.
// `interfaceHeightM` must lie strictly between 0 and `heightM`; the caller clamps it.
export function configurationFactors(
  widthM: number,
  depthM: number,
  heightM: number,
  interfaceHeightM: number,
): ConfigurationFactors {
  const w = widthM;
  const d = depthM;
  const h = interfaceHeightM;
  const upperDepth = heightM - h;
  const a1 = w * d;
  const a2 = 2 * upperDepth * (w + d);
  const a3 = 2 * h * (w + d);
  const a4 = a1;

  const f14 = parallelPlateFactor(w, d, heightM);
  const f1d = parallelPlateFactor(w, d, upperDepth);
  const f4d = parallelPlateFactor(w, d, h);

  const f = new Array<number>(16).fill(0);
  const set = (k: number, j: number, v: number): void => {
    f[4 * k + j] = v;
  };
  const get = (k: number, j: number): number => f[4 * k + j] as number;

  set(0, 0, 0);
  set(0, 1, 1 - f1d);
  set(1, 0, (a1 * get(0, 1)) / a2);
  set(1, 1, 1 - 2 * get(1, 0));
  set(0, 3, f14);
  set(3, 0, f14);

  set(3, 3, 0);
  set(3, 2, 1 - f4d);
  set(2, 3, (a4 * get(3, 2)) / a3);
  set(2, 2, 1 - 2 * get(2, 3));

  set(0, 2, 1 - get(0, 3) - get(0, 1));
  set(2, 0, (a1 * get(0, 2)) / a3);

  set(2, 1, 1 - get(2, 3) - get(2, 2) - get(2, 0));
  set(1, 2, (a3 * get(2, 1)) / a2);

  set(1, 3, 1 - get(1, 2) - get(1, 1) - get(1, 0));
  set(3, 1, (a2 * get(1, 3)) / a4);

  return { areasM2: [a1, a2, a3, a4], factors: f };
}
