// Fire plume entrainment (Tech Ref chapter 3, sections 3.3 and 3.4).
// Pure functions. SI units (m, s, kg, K, W). The Heskestad correlations are written with the convective heat
// release rate in kW and cp in kJ/(kg K), as the Tech Ref and CFAST do; the interfaces here take W and J.
import {
  CP_J_PER_KG_K,
  GRAVITY_M_PER_S2,
} from "../constants";

// ---------------------------------------------------------------------------------------------
// Plume constants. Kept next to the only code that uses them; every value cites its source.
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, fire.f90 (heskestad_plume, rho_inf = 352.981915 / t_inf): product of ambient density and temperature, kg K/m3.
const RHO_TIMES_T_KG_K_PER_M3 = 352.981915;

// Tech Ref eq. 3.17: coefficient of the Heskestad entrainment correlation.
const ENTRAINMENT_C1_COEFFICIENT = 0.196;

// Tech Ref eq. 3.17: coefficient in the second (flame-region) term of the entrainment correlation.
const ENTRAINMENT_C2_COEFFICIENT = 2.9;

// Tech Ref eq. 3.18: constant in the virtual origin z0 / D = -1.02 + 1.4 Q*^(2/5).
const VIRTUAL_ORIGIN_OFFSET = -1.02;

// Tech Ref eq. 3.18: factor on Q*^(2/5) in the virtual origin.
const VIRTUAL_ORIGIN_SLOPE = 1.4;

// Tech Ref eq. 3.19: factor on Q*^(2/5) in the mean flame height L / D = -1.02 + 3.7 Q*^(2/5).
const FLAME_HEIGHT_SLOPE = 3.7;

// Tech Ref eq. 3.18, 3.19: exponent on Q* in the virtual origin and flame height.
const QSTAR_EXPONENT = 0.4;

// CFAST 7.7.7 source, fire.f90 (heskestad_plume, max(0.0001, ...)): lower bound on the flame height and on z - z0, m.
const MIN_PLUME_LENGTH_M = 1e-4;

// Tech Ref section 3.3.2 (corner: Q and D^2 times 4, entrainment divided by 4), CFAST 7.7.7 source, fire.f90 (heskestad_plume): corner mirror factor xf.
const CORNER_MIRROR_FACTOR = 4;

// Tech Ref section 3.3.2, CFAST 7.7.7 source, fire.f90 (heskestad_plume): a fire against one wall gets no correction (V&V experiments show no wall effect).
const FREE_PLUME_MIRROR_FACTOR = 1;

// Tech Ref eq. 3.22: cap on the centreline plume temperature rise, K.
const PLUME_TEMP_RISE_MAX_K = 900;

// Tech Ref eq. 3.22, 3.27: coefficient of the centreline plume temperature rise.
const PLUME_TEMP_RISE_COEFFICIENT = 9.1;

// Tech Ref eq. 3.28: exponent on Tu / Tl in the modified virtual origin.
const MODIFIED_ORIGIN_EXPONENT = 3 / 5;

// CFAST 7.7.7 source, fire.f90 (do_fire): the weak plume limit uses at least this layer temperature difference, K.
const WEAK_PLUME_MIN_DELTA_T_K = 1;

// Tech Ref eq. 3.17: exponent 5/3 on (z - z0).
const FIVE_THIRDS = 5 / 3;

const CP_KJ_PER_KG_K = CP_J_PER_KG_K / 1000; // unit conversion
const SQRT_G = Math.sqrt(GRAVITY_M_PER_S2);

// ---------------------------------------------------------------------------------------------
// Position: free, wall or corner
// ---------------------------------------------------------------------------------------------

// Tech Ref section 3.3.2 with the CFAST 7.7.7 corner test (fire.f90, heskestad_plume): returns the mirror factor xf.
// 4 when the fire edge reaches both walls (each wall distance <= sqrt(A) / 2), otherwise 1. A fire against one wall
// is a free plume. This departs from Tech Ref 3.3.2 (wall: factor 2) because CFAST 7.7.7 does not apply it.
export function mirrorFactor(xWallDistM: number, yWallDistM: number, fireAreaM2: number): number {
  const reachM = Math.sqrt(Math.max(fireAreaM2, 0)) / 2;
  if (xWallDistM <= reachM && yWallDistM <= reachM) return CORNER_MIRROR_FACTOR;
  return FREE_PLUME_MIRROR_FACTOR;
}

// ---------------------------------------------------------------------------------------------
// Entrainment
// ---------------------------------------------------------------------------------------------

export interface PlumeInput {
  totalHrrW: number; // Q, total heat release rate (basis of Q* and z0, Tech Ref eq. 3.18)
  convectiveHrrW: number; // Qc (basis of the entrainment, Tech Ref eq. 3.17)
  fireAreaM2: number; // base area of the fire, gives D
  xWallDistM: number; // distance from the fire to the nearest wall in x
  yWallDistM: number; // distance from the fire to the nearest wall in y
  heightM: number; // z, height above the base of the fire
  ambientTempK: number; // T_inf
  pyrolysisKgS: number;
}

export interface PlumeOutput {
  entrainmentKgS: number;
  plumeFlowKgS: number; // pyrolysis + entrainment
}

export interface PlumeGeometry {
  diameterM: number; // D, with the corner factor applied
  qStar: number; // Q*, Tech Ref eq. 3.18
  virtualOriginM: number; // z0, Tech Ref eq. 3.18
  flameHeightM: number; // L, Tech Ref eq. 3.19
}

// Tech Ref eq. 3.18 and 3.19. qKw is the total heat release rate times the mirror factor, in kW.
export function plumeGeometry(qKw: number, fireAreaM2: number, mirror: number, ambientTempK: number): PlumeGeometry {
  const diameterM = Math.sqrt((fireAreaM2 * mirror) / (Math.PI / 4)); // D from A = pi D^2 / 4
  const rho = RHO_TIMES_T_KG_K_PER_M3 / ambientTempK;
  // Tech Ref eq. 3.18: Q* = Q / (rho cp T sqrt(g) D^(5/2))
  const qStar = qKw / (rho * CP_KJ_PER_KG_K * ambientTempK * SQRT_G * diameterM ** 2.5);
  // Tech Ref eq. 3.18
  const virtualOriginM = diameterM * (VIRTUAL_ORIGIN_OFFSET + VIRTUAL_ORIGIN_SLOPE * qStar ** QSTAR_EXPONENT);
  // Tech Ref eq. 3.19
  const flameHeightM = Math.max(
    MIN_PLUME_LENGTH_M,
    diameterM * (VIRTUAL_ORIGIN_OFFSET + FLAME_HEIGHT_SLOPE * qStar ** QSTAR_EXPONENT),
  );
  return { diameterM, qStar, virtualOriginM, flameHeightM };
}

// Tech Ref eq. 3.17 (above the flame), eq. 3.19 (below the flame: linear in z / L), section 3.3.2 (corner),
// CFAST 7.7.7 source, fire.f90, heskestad_plume. Entrainment in kg/s up to height z above the fire base.
// Returns zero entrainment when z <= 0 or Q <= 0, as CFAST does. Never throws; non-finite input gives zero.
export function heskestadEntrainment(input: PlumeInput): PlumeOutput {
  const { totalHrrW, convectiveHrrW, fireAreaM2, xWallDistM, yWallDistM, heightM, ambientTempK, pyrolysisKgS } = input;
  const mirror = mirrorFactor(xWallDistM, yWallDistM, fireAreaM2);
  const qTotalKw = 0.001 * totalHrrW * mirror;
  const valid =
    heightM > 0 && qTotalKw > 0 && fireAreaM2 > 0 && ambientTempK > 0 &&
    Number.isFinite(heightM + qTotalKw + fireAreaM2 + ambientTempK + convectiveHrrW);
  if (!valid) return { entrainmentKgS: 0, plumeFlowKgS: pyrolysisKgS };

  const geo = plumeGeometry(qTotalKw, fireAreaM2, mirror, ambientTempK);
  const qcKw = 0.001 * convectiveHrrW * mirror;
  // Tech Ref eq. 3.19: below the mean flame height the entrainment of eq. 3.17 at L is scaled by z / L.
  const aboveFlame = heightM > geo.flameHeightM;
  const factor = aboveFlame ? 1 : heightM / geo.flameHeightM;
  const dz = aboveFlame
    ? Math.max(MIN_PLUME_LENGTH_M, heightM - geo.virtualOriginM)
    : Math.max(MIN_PLUME_LENGTH_M, geo.flameHeightM - geo.virtualOriginM);

  const entrainmentKgS = (entrainmentEq317(qcKw, dz, ambientTempK) * factor) / mirror;
  return { entrainmentKgS, plumeFlowKgS: pyrolysisKgS + entrainmentKgS };
}

// Tech Ref eq. 3.17: m_e = 0.196 (g rho^2 / (cp T))^(1/3) Qc^(1/3) dz^(5/3) (1 + 2.9 Qc^(2/3) / ((sqrt(g) cp rho T)^(2/3) dz^(5/3))).
// qcKw in kW, dz = z - z0 in m, result in kg/s.
export function entrainmentEq317(qcKw: number, dzM: number, ambientTempK: number): number {
  const rho = RHO_TIMES_T_KG_K_PER_M3 / ambientTempK;
  const c1 = ENTRAINMENT_C1_COEFFICIENT * ((GRAVITY_M_PER_S2 * rho * rho) / (CP_KJ_PER_KG_K * ambientTempK)) ** (1 / 3);
  const c2 = ENTRAINMENT_C2_COEFFICIENT / (SQRT_G * CP_KJ_PER_KG_K * rho * ambientTempK) ** (2 / 3);
  const dz53 = dzM ** FIVE_THIRDS;
  return c1 * qcKw ** (1 / 3) * dz53 * (1 + (c2 * qcKw ** (2 / 3)) / dz53);
}

// ---------------------------------------------------------------------------------------------
// Weak plume limit
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 3.20, 3.21: m_e < Qc / (cp (Tu - Tl)). CFAST 7.7.7 (fire.f90, do_fire) uses at least 1 K for Tu - Tl.
// Returns the upper bound on the entrainment in kg/s.
export function weakPlumeLimitKgS(convectiveHrrW: number, upperTempK: number, lowerTempK: number): number {
  const deltaT = Math.max(upperTempK - lowerTempK, WEAK_PLUME_MIN_DELTA_T_K);
  return Math.max(convectiveHrrW, 0) / (CP_J_PER_KG_K * deltaT);
}

// Tech Ref eq. 3.20, 3.21 and CFAST 7.7.7 source, fire.f90 (do_fire): cap the entrainment so the lower layer keeps its
// minimum mass (the cap uses the minimum lower-layer mass vmin * rho_l) and apply the weak plume limit.
export function limitEntrainment(
  entrainmentKgS: number,
  lowerMassKg: number,
  minLowerMassKg: number,
  convectiveHrrW: number,
  upperTempK: number,
  lowerTempK: number,
): number {
  let m = entrainmentKgS;
  // CFAST 7.7.7 source, fire.f90, do_fire: keep the lower layer above its minimum mass.
  if (lowerMassKg - m <= minLowerMassKg) m = Math.max(0, lowerMassKg - minLowerMassKg);
  // Tech Ref eq. 3.21
  return Math.min(m, weakPlumeLimitKgS(convectiveHrrW, upperTempK, lowerTempK));
}

// ---------------------------------------------------------------------------------------------
// Upper-layer plume call (Requirement 6.13)
// ---------------------------------------------------------------------------------------------

export interface UpperPlumeInputs {
  plumeHeightM: number;
  fireAreaM2: number;
  xWallDistM: number;
  yWallDistM: number;
}

export interface PlumeArgs {
  fireAreaM2: number;
  xWallDistM: number;
  yWallDistM: number;
  heightM: number;
}

// CFAST 7.7.7 source, fire.f90, do_fire (upper-layer call, lines ~482-485) versus heskestad_plume (dummy argument list).
// Intended order (default): plume height goes to the height slot, fire area to the area slot, wall distances to the
// wall slots. CFAST order (cfastUpperPlumeArgOrder = true): the call passes (height, area, xDist, yDist) into the
// slots (area, x, y, z), so the area slot receives the plume height, x receives the fire area, y receives the
// x wall distance and the height slot receives the y wall distance.
export function upperPlumeArgs(inputs: UpperPlumeInputs, cfastUpperPlumeArgOrder: boolean): PlumeArgs {
  if (!cfastUpperPlumeArgOrder) {
    return {
      fireAreaM2: inputs.fireAreaM2,
      xWallDistM: inputs.xWallDistM,
      yWallDistM: inputs.yWallDistM,
      heightM: inputs.plumeHeightM,
    };
  }
  return {
    fireAreaM2: inputs.plumeHeightM,
    xWallDistM: inputs.fireAreaM2,
    yWallDistM: inputs.xWallDistM,
    heightM: inputs.yWallDistM,
  };
}

// ---------------------------------------------------------------------------------------------
// Plume above the layer interface (Tech Ref 3.4)
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 3.28: modified virtual origin z0' = zI - (Tu / Tl)^(3/5) (zI - z0), for z above the interface height zI.
export function virtualOriginAboveInterface(
  virtualOriginM: number,
  interfaceHeightAboveFireM: number,
  upperTempK: number,
  lowerTempK: number,
): number {
  return (
    interfaceHeightAboveFireM -
    (upperTempK / lowerTempK) ** MODIFIED_ORIGIN_EXPONENT * (interfaceHeightAboveFireM - virtualOriginM)
  );
}

// Tech Ref eq. 3.22: centreline plume temperature rise below the interface, K, capped at 900 K.
// qcKw in kW, dz = z - z0 in m, ambient density in kg/m3.
export function plumeTempRiseK(qcKw: number, dzM: number, ambientTempK: number, ambientDensityKgM3: number): number {
  const rise =
    PLUME_TEMP_RISE_COEFFICIENT *
    (ambientTempK / (GRAVITY_M_PER_S2 * CP_KJ_PER_KG_K ** 2 * ambientDensityKgM3 ** 2)) ** (1 / 3) *
    qcKw ** (2 / 3) *
    dzM ** -FIVE_THIRDS;
  return Math.min(PLUME_TEMP_RISE_MAX_K, rise);
}

// Tech Ref eq. 3.27: centreline plume temperature rise above the interface (z > zI), using the upper layer
// temperature and density and the modified virtual origin of eq. 3.28. dz = z - z0' in m. No 900 K cap in the Tech Ref.
export function plumeTempRiseAboveInterfaceK(
  qcKw: number,
  dzFromModifiedOriginM: number,
  upperTempK: number,
  upperDensityKgM3: number,
): number {
  return (
    PLUME_TEMP_RISE_COEFFICIENT *
    (upperTempK / (GRAVITY_M_PER_S2 * CP_KJ_PER_KG_K ** 2 * upperDensityKgM3 ** 2)) ** (1 / 3) *
    qcKw ** (2 / 3) *
    dzFromModifiedOriginM ** -FIVE_THIRDS
  );
}

// Tech Ref section 3.4 (last paragraph: "eq. 3.17 is modified the same way above the layer interface"), eq. 3.28.
// Eq. 3.17 evaluated with z0 replaced by z0' of eq. 3.28; the ambient state passed in is used unchanged.
// This is our reading of that sentence (the Tech Ref gives no separate formula); CFAST 7.7.7 does not use it, and the
// fire model's burn passes do not call it.
export function entrainmentAboveInterface(
  convectiveHrrW: number,
  heightM: number,
  modifiedOriginM: number,
  ambientTempK: number,
): number {
  const dz = Math.max(MIN_PLUME_LENGTH_M, heightM - modifiedOriginM);
  return entrainmentEq317(0.001 * convectiveHrrW, dz, ambientTempK);
}
const FLAME_HEIGHT_DIMENSIONAL_SLOPE = 0.235; // CFAST 7.7.7 source, fire.f90, flame_height (0.235 m / kW^0.4)
const FLAME_HEIGHT_MIN_M = 0.01; // CFAST 7.7.7 source, fire.f90, flame_height
// CFAST 7.7.7 source, fire.f90 (flame_height), Heskestad's mean flame height (the dimensional form of Tech Ref eq. 3.19):
// L = -1.02 D + 0.235 Q^(2/5), Q in kW, D = sqrt(4 A / pi) the diameter of the fire base, floored at 0.01 m (CFAST). Zero when Q <= 0.
// Used by the radiation model to place the point source of a fire (one third of this height above the base).
// `hrrW` is the burned heat release rate; no mirror factor is applied, as in CFAST.
export function flameHeightM(hrrW: number, fireAreaM2: number): number {
  if (!(hrrW > 0)) return 0;
  const d = Math.sqrt((4 * Math.max(fireAreaM2, 0)) / Math.PI);
  // -1.02 D: Tech Ref eq. 3.19 (VIRTUAL_ORIGIN_OFFSET is -1.02).
  return Math.max(FLAME_HEIGHT_MIN_M, VIRTUAL_ORIGIN_OFFSET * d + FLAME_HEIGHT_DIMENSIONAL_SLOPE * (hrrW / 1000) ** 0.4);
}
