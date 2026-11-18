// Radiative exchange in one compartment: four diffuse gray surfaces, two absorbing gas layers, point-source fires.
// Sources: Tech Ref section 5.1, eq. 5.1 to 5.20 (net radiation method of Siegel and Howell, gas layers by
// transmittance); CFAST 7.7.7 source, radiation.f90 (radiation, rad4, rdflux, rabs, rdrtran, rdftran).
// Surface index order: 0 ceiling, 1 upper wall, 2 lower wall, 3 floor.
import {
  FIRE_RADIATION_HEIGHT_FRACTION,
  LOW_LAYER_RADIATION_CUTOFF_FRACTION,
  RADIATION_PIVOT_MIN,
  SIGMA_SB_W_PER_M2_K4,
} from "../constants";
import { configurationFactors } from "./configFactors";
import { fireSolidAngles } from "./solidAngle";
import { transmittance } from "./gasAbsorption";

const FOUR_PI = 4 * Math.PI;
const SURFACES = 4;
const UPPER_SURFACES = 2; // surfaces 0 and 1 border the upper layer

export interface RadiationFire {
  xM: number;
  yM: number;
  baseZM: number; // height of the fire base above the compartment floor
  flameHeightM: number; // flame height, supplied by the fire module
  radiativeW: number; // radiated part of the heat release rate, chi_r Q
}

export interface RadiationInput {
  widthM: number;
  depthM: number;
  heightM: number;
  interfaceHeightM: number; // height of the layer interface above the floor
  upperTempK: number;
  lowerTempK: number;
  surfaceTempK: readonly number[]; // 4 values, order ceiling, upper wall, lower wall, floor
  emissivity: readonly number[]; // 4 values; 0 for an adiabatic surface
  upperAbsorptionPerM: number; // layerAbsorptionPerM() of the upper layer
  lowerAbsorptionPerM: number; // layerAbsorptionPerM() of the lower layer
  fires: readonly RadiationFire[];
}

export interface RadiationResult {
  fluxToSurfaceWPerM2: number[]; // net radiative flux into each surface, positive = heat flows into the surface
  absorbedUpperW: number; // radiation absorbed by the upper layer
  absorbedLowerW: number; // radiation absorbed by the lower layer
  outgoingFluxWPerM2: number[]; // radiosity leaving each surface (Tech Ref eq. 5.3 form)
  lowerRadiationOff: boolean; // true when the low-layer switch-off was applied
}

const at = (a: ArrayLike<number>, i: number): number => a[i] as number;

// CFAST 7.7.7 source, radiation.f90 (rad4): the four-by-four system is solved by LU factorisation with partial
// pivoting. Solves A x = rhs in place for row-major `a` (16 values) and returns x. A pivot with magnitude at or
// below RADIATION_PIVOT_MIN counts as singular and gives zeros, as CFAST does.
export function solveLinear4(a: readonly number[], rhs: readonly number[]): number[] {
  const m = a.slice();
  const x = rhs.slice();
  const n = SURFACES;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(at(m, n * col + col));
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(at(m, n * r + col));
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (!(best > RADIATION_PIVOT_MIN)) return [0, 0, 0, 0];
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = at(m, n * col + c);
        m[n * col + c] = at(m, n * piv + c);
        m[n * piv + c] = t;
      }
      const t = at(x, col);
      x[col] = at(x, piv);
      x[piv] = t;
    }
    const d = at(m, n * col + col);
    for (let r = col + 1; r < n; r++) {
      const f = at(m, n * r + col) / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[n * r + c] = at(m, n * r + c) - f * at(m, n * col + c);
      x[r] = at(x, r) - f * at(x, col);
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = at(x, r);
    for (let c = r + 1; c < n; c++) s -= at(m, n * r + c) * at(x, c);
    x[r] = s / at(m, n * r + r);
  }
  return x;
}

// Tech Ref eq. 5.19, 5.20; CFAST 7.7.7 source, radiation.f90 (rad4, rdrtran): beam lengths between the surface
// centres and the transmission factors through the upper layer (tauU) and the lower layer (tauL), 16 values each.
// A beam that crosses the interface is split in proportion to the heights on each side.
function surfaceTransmission(
  w: number,
  d: number,
  h: number,
  hl: number,
  aUpper: number,
  aLower: number,
): { tauU: number[]; tauL: number[] } {
  const zz = [h, (hl + h) / 2, hl / 2, 0];
  const dx2 = (w / 2) ** 2;
  const dy2 = (d / 2) ** 2;
  const x2 = w * w;
  const y2 = d * d;
  const beam = new Array<number>(16).fill(0);
  const setBeam = (i: number, j: number, v: number): void => {
    beam[SURFACES * i + j] = v;
    beam[SURFACES * j + i] = v;
  };
  const diag = (dz: number, ax: number, ay: number): number => (Math.sqrt(dz * dz + ax) + Math.sqrt(dz * dz + ay)) / 2;
  setBeam(0, 1, diag(h - at(zz, 1), dx2, dy2));
  setBeam(0, 2, diag(h - at(zz, 2), dx2, dy2));
  setBeam(0, 3, h);
  setBeam(1, 1, (w + d) / 2);
  setBeam(1, 2, diag(h / 2, x2, y2));
  setBeam(1, 3, diag((h + hl) / 2, dx2, dy2));
  setBeam(2, 2, (w + d) / 2);
  setBeam(2, 3, diag(hl / 2, dx2, dy2));

  const tauU = new Array<number>(16).fill(1);
  const tauL = new Array<number>(16).fill(1);
  const nu = UPPER_SURFACES;
  for (let i = 0; i < SURFACES; i++) {
    for (let j = 0; j < SURFACES; j++) {
      const b = at(beam, SURFACES * i + j);
      const iUp = i < nu;
      const jUp = j < nu;
      if (iUp && jUp) {
        tauU[SURFACES * i + j] = transmittance(aUpper, b);
        tauL[SURFACES * i + j] = 1;
      } else if (!iUp && !jUp) {
        tauU[SURFACES * i + j] = 1;
        tauL[SURFACES * i + j] = transmittance(aLower, b);
      } else {
        const up = iUp ? i : j;
        const lo = iUp ? j : i;
        const fu = (at(zz, up) - hl) / (at(zz, up) - at(zz, lo));
        const fl = (hl - at(zz, lo)) / (at(zz, up) - at(zz, lo));
        tauU[SURFACES * i + j] = transmittance(aUpper, b * fu);
        tauL[SURFACES * i + j] = transmittance(aLower, b * fl);
      }
    }
  }
  return { tauU, tauL };
}

// Tech Ref eq. 5.19, 5.20; CFAST 7.7.7 source, radiation.f90 (rdftran): transmission from a point-source fire at
// height zf to the centre of each surface, through the upper layer (taufU) and the lower layer (taufL).
function fireTransmission(zf: number, hl: number, aUpper: number, aLower: number, h: number): { taufU: number[]; taufL: number[] } {
  const zz = [h, (hl + h) / 2, hl / 2, 0];
  const taufU = [1, 1, 1, 1];
  const taufL = [1, 1, 1, 1];
  for (let j = 0; j < SURFACES; j++) {
    const zj = at(zz, j);
    if (j < UPPER_SURFACES) {
      if (zf > hl) {
        taufU[j] = transmittance(aUpper, Math.abs(zj - zf));
        taufL[j] = 1;
      } else {
        taufU[j] = transmittance(aUpper, zj - hl);
        taufL[j] = transmittance(aLower, hl - zf);
      }
    } else if (zf <= hl) {
      taufU[j] = 1;
      taufL[j] = transmittance(aLower, Math.abs(zj - zf));
    } else {
      taufU[j] = transmittance(aUpper, zf - hl);
      taufL[j] = transmittance(aLower, hl - zj);
    }
  }
  return { taufU, taufL };
}

// CFAST 7.7.7 source, radiation.f90 (radiation): the fire radiates as a point source at one third of the flame
// height above its base, with the flame height capped so that the flame does not pass the ceiling.
export function fireRadiationHeightM(baseZM: number, flameHeightM: number, ceilingHeightM: number): number {
  const flame = baseZM + flameHeightM > ceilingHeightM ? ceilingHeightM - baseZM : flameHeightM;
  return baseZM + flame * FIRE_RADIATION_HEIGHT_FRACTION;
}

// Tech Ref eq. 5.1 to 5.20; CFAST 7.7.7 source, radiation.f90 (rad4, rdflux, rabs).
// Net radiation method for four surfaces. Unknown: the net-flux driver dq_k of each surface from
//   sum_j [delta_kj - F_kj tau_kj (1 - eps_j)] dq_j = sum_j [delta_kj - F_kj tau_kj] e_j - c_k
// where e_j = sigma T_j^4, tau_kj is the product of the transmittances through both layers, and c_k collects
// gas-layer emission and the fire's radiation reaching surface k (Tech Ref eq. 5.6, 5.8 to 5.12). The flux
// into surface k is eps_k times the solution, with the sign changed. Layer absorption sums gas emission,
// the fire's absorbed share and the surface radiosity absorbed on its way through each layer.
// Low lower layer (CFAST 7.7.7 source, radiation.f90 (rad4), radiation_fix): when the interface is at or below
// 1e-4 of the ceiling height, the interface is taken at that height for the geometry and the radiation to the
// lower layer, to the lower wall and to the floor is switched off.
export function surfaceRadiation(input: RadiationInput): RadiationResult {
  const w = input.widthM;
  const d = input.depthM;
  const h = input.heightM;
  const cutoff = LOW_LAYER_RADIATION_CUTOFF_FRACTION;
  const lowerOff = input.interfaceHeightM / h <= cutoff;
  // Keep both layers non-degenerate so that no surface area or beam length reaches zero.
  const hl = Math.min(Math.max(input.interfaceHeightM, cutoff * h), (1 - cutoff) * h);
  const factorLower = lowerOff ? 0 : 1;

  const { areasM2: area, factors: figs } = configurationFactors(w, d, h, hl);
  const { tauU, tauL } = surfaceTransmission(w, d, h, hl, input.upperAbsorptionPerM, input.lowerAbsorptionPerM);

  const e = input.surfaceTempK.map((t) => SIGMA_SB_W_PER_M2_K4 * t ** 4);
  const eps = input.emissivity;
  const a = new Array<number>(16).fill(0);
  const b = new Array<number>(16).fill(0);
  for (let k = 0; k < SURFACES; k++) {
    for (let j = 0; j < SURFACES; j++) {
      const idx = SURFACES * k + j;
      const aij = at(figs, idx) * at(tauL, idx) * at(tauU, idx);
      a[idx] = -aij * (1 - at(eps, j)) + (k === j ? 1 : 0);
      b[idx] = -aij + (k === j ? 1 : 0);
    }
  }

  // Source vector c and the layer absorption from gas emission and fires (CFAST rdflux).
  const eu = SIGMA_SB_W_PER_M2_K4 * input.upperTempK ** 4;
  const el = SIGMA_SB_W_PER_M2_K4 * input.lowerTempK ** 4;
  const c = [0, 0, 0, 0];
  let qUpper = 0;
  let qLower = 0;
  const nu = UPPER_SURFACES;
  for (let k = 0; k < SURFACES; k++) {
    let ck = 0;
    for (let j = 0; j < SURFACES; j++) {
      const idx = SURFACES * k + j;
      const f = at(figs, idx);
      const wf = at(area, k) * f;
      const qu = (1 - at(tauU, idx)) * eu;
      const ql = (1 - at(tauL, idx)) * el;
      if (k < nu && j < nu) {
        ck += f * qu;
        qUpper -= wf * qu;
      } else if (k < nu) {
        ck += f * (qu + ql * at(tauU, idx));
        qUpper += ql * wf * (1 - at(tauU, idx)) - qu * wf;
        qLower -= ql * wf;
      } else if (j < nu) {
        ck += f * (qu * at(tauL, idx) + ql);
        qUpper -= qu * wf;
        qLower += qu * wf * (1 - at(tauL, idx)) - ql * wf;
      } else {
        ck += f * ql;
        qLower -= ql * wf;
      }
    }
    c[k] = ck;
  }

  for (const fire of input.fires) {
    if (!(fire.radiativeW > 0)) continue;
    const zf = fireRadiationHeightM(fire.baseZM, fire.flameHeightM, h);
    const angles = fireSolidAngles(w, d, h, hl, fire.xM, fire.yM, zf);
    const { taufU, taufL } = fireTransmission(zf, hl, input.upperAbsorptionPerM, input.lowerAbsorptionPerM, h);
    for (let k = 0; k < SURFACES; k++) {
      const flux = (fire.radiativeW * at(angles, k)) / (FOUR_PI * at(area, k));
      c[k] = at(c, k) + flux * at(taufL, k) * at(taufU, k);
      let factU: number;
      let factL: number;
      if (k < nu) {
        if (zf > hl) {
          factU = 1 - at(taufU, k);
          factL = 0;
        } else {
          factU = (1 - at(taufU, k)) * at(taufL, k);
          factL = 1 - at(taufL, k);
        }
      } else if (zf > hl) {
        factU = 1 - at(taufU, k);
        factL = (1 - at(taufL, k)) * at(taufU, k);
      } else {
        factU = 0;
        factL = 1 - at(taufL, k);
      }
      qUpper += factU * flux * at(area, k);
      qLower += factL * flux * at(area, k);
    }
  }

  const rhs = [0, 0, 0, 0];
  for (let k = 0; k < SURFACES; k++) {
    let s = 0;
    for (let j = 0; j < SURFACES; j++) s += at(b, SURFACES * k + j) * at(e, j);
    rhs[k] = s - at(c, k);
  }
  const dqde = solveLinear4(a, rhs);

  const outgoing = [0, 0, 0, 0];
  const flux = [0, 0, 0, 0];
  for (let k = 0; k < SURFACES; k++) {
    outgoing[k] = at(e, k) - (1 - at(eps, k)) * at(dqde, k);
    flux[k] = -at(dqde, k) * at(eps, k);
  }
  flux[2] = factorLower * at(flux, 2);
  flux[3] = factorLower * at(flux, 3);

  // Energy that the layers absorb from the radiosity of the surfaces (CFAST rabs).
  for (let k = 0; k < SURFACES; k++) {
    const qk = at(outgoing, k) * at(area, k);
    for (let j = 0; j < SURFACES; j++) {
      const idx = SURFACES * k + j;
      const f = at(figs, idx);
      if (k < nu && j < nu) {
        qUpper += qk * f * (1 - at(tauU, idx));
      } else if (k < nu) {
        qUpper += qk * f * (1 - at(tauU, idx));
        qLower += qk * f * at(tauU, idx) * (1 - at(tauL, idx));
      } else if (j < nu) {
        qUpper += qk * f * at(tauL, idx) * (1 - at(tauU, idx));
        qLower += qk * f * (1 - at(tauL, idx));
      } else {
        qLower += qk * f * (1 - at(tauL, idx));
      }
    }
  }

  return {
    fluxToSurfaceWPerM2: flux,
    absorbedUpperW: qUpper,
    absorbedLowerW: factorLower * qLower,
    outgoingFluxWPerM2: outgoing,
    lowerRadiationOff: lowerOff,
  };
}
