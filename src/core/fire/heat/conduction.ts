// One-dimensional heat conduction into a compartment surface of up to three layers.
// SI units. Node 0 is the exposed face, the last node is the back face. Layers are ordered from the exposed face inward.
//
// The surface temperature is the unknown of the solver (Tech Ref 5.4). Each call solves the wall profile from a trial
// surface temperature and returns the temperature gradient at the exposed face. The caller builds the residual
// q'' + k dT/dx and keeps the trial profile only when the step is accepted.
import {
  CONDUCTION_BREAKPOINT_FRACTION,
  CONDUCTION_MAX_LAYERS,
  CONDUCTION_MIN_INTERIOR_NODES_PER_LAYER,
  CONDUCTION_NODE_COUNT,
  SIGMA_SB_W_PER_M2_K4,
  SLAB_SPLIT_INNER,
  SLAB_SPLIT_MIDDLE,
  SLAB_SPLIT_OUTER,
} from "../constants";
import type { Surface, SurfaceLayer } from "../types";
import { convectiveFlux, type ConvectionSurfaceKind } from "./convection";

export interface ConductionResult {
  gradientKPerM: number; // (T1 - T0) / dx0 at the exposed face
  dGradientDTw: number; // partial of the gradient with respect to the surface temperature, 1/m
}

export interface WallGrid {
  nodeCount: number;
  layerCount: number;
  interiorNodesPerLayer: number[]; // CFAST n_nodes(2:nslab+1)
  xM: Float64Array; // node positions from the exposed face
  dxM: Float64Array; // node spacings, length nodeCount - 1
  thicknessM: number;
  conductivityWPerMK: number[]; // per layer
  diffusivityM2PerS: number[]; // per layer, k / (rho c)
  // Scratch space for the tridiagonal solve. Owned by this grid, overwritten by every call.
  lower: Float64Array;
  diag: Float64Array;
  upper: Float64Array;
  rhs: Float64Array;
  deriv: Float64Array;
  result: ConductionResult;
}

// Slab split fractions for layers 1, 2 and 3.
// CFAST 7.7.7 source, cfast_data.f90 (slab_splits); constants.ts SLAB_SPLIT_*.
const SLAB_SPLITS: readonly number[] = [SLAB_SPLIT_INNER, SLAB_SPLIT_MIDDLE, SLAB_SPLIT_OUTER];

// Fortran integer division truncates toward zero.
const idiv = (a: number, b: number): number => Math.trunc(a / b);

// Number of interior nodes per layer for two or three layers.
// CFAST 7.7.7 source, initialization.f90, initialize_wall_nodes (multi-slab branch).
// Note: for a middle layer CFAST uses the thickness of the LAST layer in its formula. We follow CFAST because the
// validation gate compares with CFAST. The sum is forced to nintx and every layer keeps at least one node.
function interiorNodeCounts(layers: readonly SurfaceLayer[], nx: number, xbM: number, wallM: number): number[] {
  const nslab = layers.length;
  const nintx = nx - (nslab + 1);
  const first = layers[0] as SurfaceLayer;
  const last = layers[nslab - 1] as SurfaceLayer;
  const minN = CONDUCTION_MIN_INTERIOR_NODES_PER_LAYER;
  const numpts = new Array<number>(nslab).fill(0);
  numpts[0] = Math.max(minN, Math.trunc(((SLAB_SPLITS[0] as number) * nintx * Math.min(xbM, first.thicknessM)) / wallM));
  numpts[nslab - 1] = Math.max(
    minN,
    Math.trunc(((SLAB_SPLITS[2] as number) * nintx * Math.min(wallM - xbM, last.thicknessM)) / wallM),
  );
  let isum = nintx - (numpts[0] as number) - (numpts[nslab - 1] as number);
  for (let i = 1; i < nslab - 1; i++) {
    numpts[i] = Math.max(
      minN,
      Math.trunc((nx * (SLAB_SPLITS[1] as number) * last.thicknessM) / (nslab - 2) / wallM),
    );
    isum -= numpts[i] as number;
  }
  numpts[0] = (numpts[0] as number) + (isum - idiv(isum, 2));
  numpts[nslab - 1] = (numpts[nslab - 1] as number) + idiv(isum, 2);
  // Safety: CFAST fixes only the last layer. Keep every layer at or above the minimum and the sum at nintx.
  for (let i = 0; i < nslab; i++) {
    while ((numpts[i] as number) < minN) {
      let donor = 0;
      for (let j = 1; j < nslab; j++) if ((numpts[j] as number) > (numpts[donor] as number)) donor = j;
      numpts[donor] = (numpts[donor] as number) - 1;
      numpts[i] = (numpts[i] as number) + 1;
    }
  }
  return numpts;
}

// Node positions, graded toward the exposed face in the first layer and toward the back face in the last layer.
// CFAST 7.7.7 source, initialization.f90, initialize_wall_nodes (replaces Tech Ref eq. 5.30; the penetration depth is not used).
// Throws TypeError for 0 or more than 3 layers (programmer error, the validator rejects such input).
export function placeNodes(layers: readonly SurfaceLayer[]): WallGrid {
  const nslab = layers.length;
  if (nslab < 1 || nslab > CONDUCTION_MAX_LAYERS) {
    throw new TypeError(`placeNodes: expected 1 to ${CONDUCTION_MAX_LAYERS} layers, got ${nslab}`);
  }
  const nx = CONDUCTION_NODE_COUNT;
  const xpos = new Array<number>(nslab + 1).fill(0);
  for (let s = 0; s < nslab; s++) xpos[s + 1] = (xpos[s] as number) + (layers[s] as SurfaceLayer).thicknessM;
  const wallM = xpos[nslab] as number;
  const xbM = CONDUCTION_BREAKPOINT_FRACTION * wallM;
  const x = new Float64Array(nx);
  let perLayer: number[];

  if (nslab === 1) {
    // One layer: nsplit intervals pack nodes at the exposed face, the rest at the back face.
    const nsplit = Math.trunc((SLAB_SPLITS[0]! + SLAB_SPLITS[1]!) * nx);
    for (let i = 0; i <= nsplit; i++) x[i] = xbM * (i / nsplit) ** 2;
    const w = 1 / (nx - (nsplit + 1));
    for (let i = nsplit + 1; i < nx; i++) x[i] = wallM - (wallM - xbM) * ((nx - i - 1) * w) ** 2;
    perLayer = [nx - 2];
  } else {
    perLayer = interiorNodeCounts(layers, nx, xbM, wallM);
    const cum = new Array<number>(nslab + 1).fill(0); // index of the first node of each layer (0-based)
    for (let s = 0; s < nslab; s++) cum[s + 1] = (cum[s] as number) + (perLayer[s] as number) + 1;
    // First layer, bunched toward the exposed face.
    const nint = (perLayer[0] as number) + 1;
    for (let i = 0; i < nint; i++) x[i] = (i * i * (xpos[1] as number)) / (nint * nint);
    // Middle layers, uniform.
    for (let s = 1; s < nslab - 1; s++) {
      const ibeg = cum[s] as number;
      const iend = (cum[s + 1] as number) - 1;
      const n = iend + 1 - ibeg;
      for (let i = ibeg; i <= iend; i++) x[i] = ((xpos[s] as number) * (iend + 1 - i) + (xpos[s + 1] as number) * (i - ibeg)) / n;
    }
    // Last layer, bunched toward the back face (includes the last node).
    const ibeg = cum[nslab - 1] as number;
    const iend = cum[nslab] as number;
    const n = iend - ibeg;
    const tLast = (layers[nslab - 1] as SurfaceLayer).thicknessM;
    for (let i = ibeg; i <= iend; i++) x[i] = wallM - ((iend - i) ** 2 * tLast) / (n * n);
  }

  const dx = new Float64Array(nx - 1);
  for (let i = 0; i < nx - 1; i++) dx[i] = (x[i + 1] as number) - (x[i] as number);

  return {
    nodeCount: nx,
    layerCount: nslab,
    interiorNodesPerLayer: perLayer,
    xM: x,
    dxM: dx,
    thicknessM: wallM,
    conductivityWPerMK: layers.map((l) => l.conductivityWPerMK),
    diffusivityM2PerS: layers.map((l) => l.conductivityWPerMK / (l.specificHeatJPerKgK * l.densityKgPerM3)),
    lower: new Float64Array(nx),
    diag: new Float64Array(nx),
    upper: new Float64Array(nx),
    rhs: new Float64Array(nx),
    deriv: new Float64Array(nx),
    result: { gradientKPerM: 0, dGradientDTw: 0 },
  };
}

// Grid for a Surface, or null for an explicit adiabatic surface (CFAST material OFF, Requirement 2.4).
// Tech Ref 5.4 (conduction through the walls) and CFAST 7.7.7 source, conduction.f90 (cnduct, wall node grid): node positions of the graded grid.
export function buildWallGrid(surface: Surface): WallGrid | null {
  return "adiabatic" in surface ? null : placeNodes(surface.layers);
}

// Initial profile, linear between the interior and exterior ambient temperatures over nodes 1 to n-2,
// with the end nodes set to the ambient values.
// CFAST 7.7.7 source, initialization.f90, initialize_wall_nodes (end of routine).
export function initialProfile(grid: WallGrid, interiorTempK: number, exteriorTempK: number): Float64Array {
  const n = grid.nodeCount;
  const t = new Float64Array(n);
  t[0] = interiorTempK;
  t[n - 1] = exteriorTempK;
  const x1 = grid.xM[1] as number;
  const slope = (exteriorTempK - interiorTempK) / ((grid.xM[n - 2] as number) - x1);
  for (let i = 1; i < n - 1; i++) t[i] = interiorTempK + ((grid.xM[i] as number) - x1) * slope;
  return t;
}

// Heat flux into the back face from the exterior ambient: convection plus black-body radiation, W/m2.
// CFAST 7.7.7 source, conduction.f90, conduction (boundary type 3). The back-face temperature is the lagged value
// from the last accepted step. The back face of a ceiling or floor is horizontal, of a wall is vertical.
export function backFaceFlux(kind: ConvectionSurfaceKind, exteriorTempK: number, backTempK: number): number {
  return (
    convectiveFlux(kind, exteriorTempK, backTempK) +
    SIGMA_SB_W_PER_M2_K4 * (exteriorTempK ** 4 - backTempK ** 4)
  );
}

// Backward Euler step of the wall profile for a trial surface temperature, Tech Ref eq. 5.28, 5.29, 5.32 to 5.35
// (Cartesian limit), with the node layout and boundary treatment of CFAST 7.7.7 source, conduction.f90, conductive_flux.
//  - node 0: Dirichlet, T0 = surfaceTempK
//  - interior nodes: second-order central differences on the non-uniform grid, implicit in time
//  - layer interface nodes: flux continuity, no heat storage
//  - last node: flux condition T[n-1] - T[n-2] = dx q_back / k_last, with q_back evaluated by the caller from lagged temperatures
// `current` is not modified. The new profile is written to `trial`. The caller copies trial to current (commitProfile)
// only when the step is accepted. The returned object belongs to the grid and is overwritten by the next call.
export function stepConduction(
  grid: WallGrid,
  current: Float64Array,
  trial: Float64Array,
  surfaceTempK: number,
  dtS: number,
  backFluxWPerM2: number,
): ConductionResult {
  const nx = grid.nodeCount;
  const { lower: a_lo, diag: a, upper: a_up, rhs, deriv, dxM: dx } = grid;

  // First row: Dirichlet value at the exposed face.
  a[0] = 1;
  a_up[0] = 0;
  a_lo[0] = 0;
  rhs[0] = surfaceTempK;

  // Interior nodes of each layer, then the interface node that follows it.
  let cursor = 0;
  for (let s = 0; s < grid.layerCount; s++) {
    const sCoef = 2 * dtS * (grid.diffusivityM2PerS[s] as number);
    const first = cursor + 1;
    const last = first + (grid.interiorNodesPerLayer[s] as number) - 1;
    for (let i = first; i <= last; i++) {
      const hi = dx[i] as number;
      const him1 = dx[i - 1] as number;
      a[i] = 1 + sCoef / (hi * him1);
      a_lo[i] = -sCoef / (him1 * (hi + him1));
      a_up[i] = -sCoef / (hi * (hi + him1));
      rhs[i] = current[i] as number;
    }
    cursor = last + 1;
    if (s < grid.layerCount - 1) {
      // Interface node between layer s and s + 1: k_left (T[i-1] - T[i]) / dx_left + k_right (T[i+1] - T[i]) / dx_right = 0.
      const lo = (grid.conductivityWPerMK[s] as number) / (dx[cursor - 1] as number);
      const up = (grid.conductivityWPerMK[s + 1] as number) / (dx[cursor] as number);
      a_lo[cursor] = lo;
      a_up[cursor] = up;
      a[cursor] = -(lo + up);
      rhs[cursor] = 0;
    }
  }

  // Last row: flux boundary using the lagged back-face flux.
  const kLast = grid.conductivityWPerMK[grid.layerCount - 1] as number;
  a[nx - 1] = 1;
  a_lo[nx - 1] = -1;
  a_up[nx - 1] = 0;
  rhs[nx - 1] = ((dx[nx - 2] as number) * backFluxWPerM2) / kLast;

  // Thomas algorithm (LU without pivoting; the matrix is diagonally dominant). deriv carries d T_i / d T_0.
  a_up[0] = (a_up[0] as number) / (a[0] as number);
  for (let i = 1; i < nx - 1; i++) {
    a[i] = (a[i] as number) - (a_lo[i] as number) * (a_up[i - 1] as number);
    a_up[i] = (a_up[i] as number) / (a[i] as number);
  }
  a[nx - 1] = (a[nx - 1] as number) - (a_lo[nx - 1] as number) * (a_up[nx - 2] as number);

  deriv.fill(0);
  deriv[0] = 1;
  rhs[0] = (rhs[0] as number) / (a[0] as number);
  deriv[0] = (deriv[0] as number) / (a[0] as number);
  for (let i = 1; i < nx; i++) {
    rhs[i] = ((rhs[i] as number) - (a_lo[i] as number) * (rhs[i - 1] as number)) / (a[i] as number);
    deriv[i] = ((deriv[i] as number) - (a_lo[i] as number) * (deriv[i - 1] as number)) / (a[i] as number);
  }
  for (let i = nx - 2; i >= 0; i--) {
    rhs[i] = (rhs[i] as number) - (a_up[i] as number) * (rhs[i + 1] as number);
    deriv[i] = (deriv[i] as number) - (a_up[i] as number) * (deriv[i + 1] as number);
  }

  for (let i = 0; i < nx; i++) trial[i] = rhs[i] as number;

  // First-order gradient over the first interval (CFAST 7.7.7 source, conduction.f90, tgrad(2)).
  const dx0 = dx[0] as number;
  grid.result.gradientKPerM = ((trial[1] as number) - (trial[0] as number)) / dx0;
  grid.result.dGradientDTw = ((deriv[1] as number) - 1) / dx0;
  return grid.result;
}

// Accept a step: the trial profile becomes the current profile (Tech Ref 5.4).
export function commitProfile(trial: Float64Array, current: Float64Array): void {
  current.set(trial);
}

// Gradient used in the residual of one surface. Returns zero gradient, and leaves the profiles alone, for an
// explicit adiabatic surface (grid is null) and for every surface when options.adiabatic is true.
// CFAST 7.7.7 source, conduction.f90, conduction (vtgrad = 0 when adiabatic_walls or the surface is off).
export function surfaceGradient(
  grid: WallGrid | null,
  adiabaticOption: boolean,
  current: Float64Array | null,
  trial: Float64Array | null,
  surfaceTempK: number,
  dtS: number,
  backFluxWPerM2: number,
): ConductionResult {
  if (grid === null || adiabaticOption || current === null || trial === null) return ZERO_CONDUCTION;
  return stepConduction(grid, current, trial, surfaceTempK, dtS, backFluxWPerM2);
}

const ZERO_CONDUCTION: ConductionResult = Object.freeze({ gradientKPerM: 0, dGradientDTw: 0 });

// Tech Ref eq. 2.9, 5.27 and C.2: residual q'' + k dT/dx of the surface energy balance, W/m2.
// netFluxIntoSurfaceWPerM2 is the sum of convective and radiative flux into the surface. k1 is the conductivity of
// the first layer (0 for an adiabatic surface, which gives a residual equal to the net flux).
export function conductionResidual(netFluxIntoSurfaceWPerM2: number, gradientKPerM: number, k1WPerMK: number): number {
  return netFluxIntoSurfaceWPerM2 + gradientKPerM * k1WPerMK;
}
