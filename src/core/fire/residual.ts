// Assembles the residual F(t, y, y') of the two-zone model from the physics modules (Tech Ref appendix C, eq. C.1, C.2).
//
//   gas rows (p, Vu, Tu, Tl):   F = y' - f(t, y)              Tech Ref eq. 2.5 to 2.8 (C.2, top line)
//   surface rows (4 per room):  F = q'' + k dT/dx |x=0         Tech Ref eq. 2.9 (C.2, bottom line)
//
// What the residual reads and what it writes:
//  - it reads y and y' and the work space `ws`; it never changes the accepted wall profiles (`ws.current`) or the
//    species state (`ws.species`). Both change only through `commitWalls` and by the driver after an accepted step
//    (Tech Ref 5.4; design "Trial and current profiles").
//  - each evaluation writes the trial wall profiles, the per-fire and per-vent results of the last evaluation and the
//    species flow ledger. The driver calls `evaluateModel` at the accepted state to read them.
// Scratch arrays are allocated once in `createWorkspace`. The physics modules allocate small result objects of their own.
import { CP_J_PER_KG_K, GAS_R_J_PER_KG_K } from "./constants";
import { flameHeightM } from "./fire/plume";
import { evaluateFire, fireDrive, type FireEvaluation } from "./fire/heatRelease";
import { layerDerivatives, interfaceHeightM, type LayerSourceTerms, type LayerState } from "./gas/layerEquations";
import { layerMixing } from "./gas/layerMixing";
import { lowerVolumeM3, mergeShaftFlows } from "./gas/minVolume";
import { ceilingConvection, convectiveFlux } from "./heat/convection";
import {
  backFaceFlux,
  buildWallGrid,
  commitProfile,
  conductionResidual,
  initialProfile,
  stepConduction,
  surfaceGradient,
  type WallGrid,
} from "./heat/conduction";
import { layerAbsorptionPerM } from "./heat/gasAbsorption";
import { surfaceRadiation, type RadiationFire } from "./heat/radiation";
import type { CompartmentModel, Model, VentModel } from "./model";
import type { ResidualFn } from "./solver/jacobian";
import {
  LAYER_LOWER,
  LAYER_UPPER,
  SPECIES_CO2,
  SPECIES_COUNT,
  SPECIES_H2O,
  SPECIES_O2,
  SPECIES_SOOT,
  SPECIES_CO,
  SPECIES_N2,
  SPECIES_UHC,
  createSpeciesState,
  layerNode,
  massFraction,
  type LayerTransfer,
  type SpeciesFlows,
  type SpeciesState,
} from "./species/tracker";
import {
  SURFACE_CEILING,
  SURFACE_COUNT,
  SURFACE_LOWER_WALL,
  SURFACE_UPPER_WALL,
  VARS_PER_COMPARTMENT,
  VAR_P,
  VAR_TL,
  VAR_TU,
  VAR_TW,
  VAR_VU,
  initialLayerMassesKg,
} from "./state";
import { openFractionAt } from "./vents/openFraction";
import { ceilingFloorVentFlows, type CeilingFloorVentGeometry } from "./vents/ceilingFloorVent";
import { leakageFlows } from "./vents/leakage";
import {
  outsideEnd,
  type MassTransfer,
  type VentFlowResult,
  type VentLayer,
  type VerticalVentEndState,
} from "./vents/ventTypes";
import { wallVentFlows, type WallVentGeometry } from "./vents/wallVent";
// Record of the layer-to-layer flows of the last evaluation, in the form the species tracker needs.
export interface FlowLedger {
  count: number;
  from: Int32Array;
  to: Int32Array;
  kgPerS: Float64Array;
  exteriorOutKgPerS: Float64Array; // per layer node
  sourceKgPerS: Float64Array; // per layer node and species, `node * SPECIES_COUNT + species`
}
export interface Workspace {
  // Species state read by the residual (oxygen for the fire, CO2, H2O and soot for gas absorption). The driver
  // advances it after each accepted step. The residual never writes it.
  species: SpeciesState;
  // Time to which `current` belongs. The conduction step of an evaluation at time t is t - profileTimeS.
  profileTimeS: number;
  grids: (WallGrid | null)[]; // compartment * SURFACE_COUNT + surface
  current: Float64Array[]; // accepted wall profiles, read-only in the residual
  trial: Float64Array[]; // profiles solved from the trial surface temperature
  // Results of the last evaluation.
  fireEvals: FireEvaluation[];
  ventResults: (VentFlowResult | null)[];
  ledger: FlowLedger;
  // Scratch.
  rhs: Float64Array; // f of the gas rows and the full surface rows, before the y' term
  sources: LayerSourceTerms[];
  layerState: LayerState;
  deriv: Float64Array;
  ends: VerticalVentEndState[]; // gas state at the vent end of each compartment
  outsideEnds: (VerticalVentEndState | null)[]; // per vent, the Outside end (null when both ends are compartments)
  wallGeometry: WallVentGeometry[]; // per vent, open fraction updated each evaluation
  ceilingGeometry: CeilingFloorVentGeometry[];
  radSurfaceTemp: number[][];
  radEmissivity: number[][];
  radFires: RadiationFire[][];
  upperDepthM: Float64Array;
  lowerMassKg: Float64Array;
  lowerDensityKgPerM3: Float64Array;
}
function initialLedger(nodes: number): FlowLedger {
  const cap = 16;
  return {
    count: 0,
    from: new Int32Array(cap),
    to: new Int32Array(cap),
    kgPerS: new Float64Array(cap),
    exteriorOutKgPerS: new Float64Array(nodes),
    sourceKgPerS: new Float64Array(nodes * SPECIES_COUNT),
  };
}
function growLedger(l: FlowLedger): void {
  const cap = l.from.length * 2;
  const from = new Int32Array(cap);
  const to = new Int32Array(cap);
  const kg = new Float64Array(cap);
  from.set(l.from);
  to.set(l.to);
  kg.set(l.kgPerS);
  l.from = from;
  l.to = to;
  l.kgPerS = kg;
}
function blankEnd(c: CompartmentModel): VerticalVentEndState {
  return {
    isOutside: false,
    floorElevationM: c.floorElevationM,
    heightM: c.heightM,
    interfaceHeightM: 0,
    floorPressurePa: 0,
    upperTempK: 0,
    lowerTempK: 0,
    upperDensityKgPerM3: 0,
    lowerDensityKgPerM3: 0,
    upperVolumeM3: 0,
    lowerVolumeM3: 0,
    minVolumeM3: c.vminM3,
  };
}
// Requirements 2.1, 11.4: all mutable state of a run in one object, created fresh for each run. Wall profiles start
// linear between the interior and exterior ambient temperatures (design Heat transfer modules, "Initial profile").
export function createWorkspace(model: Model): Workspace {
  const nC = model.compartments.length;
  const grids: (WallGrid | null)[] = [];
  const current: Float64Array[] = [];
  const trial: Float64Array[] = [];
  for (const c of model.compartments) {
    for (let s = 0; s < SURFACE_COUNT; s++) {
      const surf = c.surfaces[s];
      const grid = surf === undefined ? null : buildWallGrid(surf.surface);
      grids.push(grid);
      current.push(grid === null ? new Float64Array(0) : initialProfile(grid, model.interiorTempK, model.exteriorTempK));
      trial.push(grid === null ? new Float64Array(0) : new Float64Array(grid.nodeCount));
    }
  }
  const ends = model.compartments.map(blankEnd);
  const outsideEnds = model.vents.map((v): VerticalVentEndState | null => {
    const [a, b] = v.ends;
    if (a >= 0 && b >= 0) return null;
    const partner = ends[a >= 0 ? a : b] as VerticalVentEndState;
    return { ...outsideEnd(partner, model.outsideAmbient), upperVolumeM3: 0, lowerVolumeM3: 0, minVolumeM3: partner.minVolumeM3 };
  });
  return {
    species: createSpeciesState(initialLayerMassesKg(model), model.ambient.species),
    profileTimeS: 0,
    grids,
    current,
    trial,
    fireEvals: [],
    ventResults: model.vents.map(() => null),
    ledger: initialLedger(2 * nC),
    rhs: new Float64Array(VARS_PER_COMPARTMENT * nC),
    sources: model.compartments.map(() => ({ qUpperW: 0, qLowerW: 0, mdotUpperKgPerS: 0, mdotLowerKgPerS: 0 })),
    layerState: { pressurePa: 0, upperVolumeM3: 0, upperTempK: 0, lowerTempK: 0 },
    deriv: new Float64Array(4),
    ends,
    outsideEnds,
    wallGeometry: model.vents.map((v) => ({
      sillM: v.kind === "wall" ? v.sillM : 0,
      soffitM: v.kind === "wall" ? v.soffitM : 0,
      widthM: v.kind === "wall" ? v.widthM : 0,
      openFraction: 1,
    })),
    ceilingGeometry: model.vents.map((v) => ({
      areaM2: v.kind === "ceilingFloor" ? v.areaM2 : 0,
      shape: v.kind === "ceilingFloor" ? v.shape : "round",
      openFraction: 1,
    })),
    radSurfaceTemp: model.compartments.map(() => [0, 0, 0, 0]),
    radEmissivity: model.compartments.map((c) => c.surfaces.map((s) => s.emissivity)),
    radFires: model.compartments.map(() => []),
    upperDepthM: new Float64Array(nC),
    lowerMassKg: new Float64Array(nC),
    lowerDensityKgPerM3: new Float64Array(nC),
  };
}
// Node of the species tracker that receives a layer of a compartment. A shaft is one zone, so its lower layer
// maps to its upper node (design Gas state module, shaft mode).
function nodeOf(c: CompartmentModel, layer: VentLayer): number {
  return layerNode(c.index, layer === "lower" && !c.isShaft ? LAYER_LOWER : LAYER_UPPER);
}
function recordTransfer(ws: Workspace, fromNode: number, toNode: number, kgPerS: number): void {
  if (fromNode === toNode || !(kgPerS > 0)) return;
  const l = ws.ledger;
  if (l.count === l.from.length) growLedger(l);
  l.from[l.count] = fromNode;
  l.to[l.count] = toNode;
  l.kgPerS[l.count] = kgPerS;
  l.count++;
}
// Tech Ref eq. 2.5 to 2.8, App. B: a mass transfer changes the mass flow of both layers and carries the enthalpy
// cp m T of the gas that moves. The term of the outflow, -cp m T_layer, is cancelled by -cp mdot T in eq. 2.7 and 2.8.
function applyTransfers(model: Model, ws: Workspace, transfers: readonly MassTransfer[], c0: number, c1: number): void {
  const ledger = ws.ledger;
  const comp = (end: 0 | 1): CompartmentModel | undefined => model.compartments[end === 0 ? c0 : c1];
  const idx = (end: 0 | 1): number => (end === 0 ? c0 : c1);
  for (const t of transfers) {
    const m = t.massKgS;
    if (!(m > 0)) continue;
    const enthalpy = CP_J_PER_KG_K * m * t.sourceTempK;
    const fromC = idx(t.fromEnd) >= 0 ? comp(t.fromEnd) : undefined;
    const toC = idx(t.toEnd) >= 0 ? comp(t.toEnd) : undefined;
    if (fromC !== undefined) {
      const s = ws.sources[fromC.index] as LayerSourceTerms;
      if (t.fromLayer === "upper") {
        s.mdotUpperKgPerS -= m;
        s.qUpperW -= enthalpy;
      } else {
        s.mdotLowerKgPerS -= m;
        s.qLowerW -= enthalpy;
      }
    }
    if (toC !== undefined) {
      const s = ws.sources[toC.index] as LayerSourceTerms;
      if (t.toLayer === "upper") {
        s.mdotUpperKgPerS += m;
        s.qUpperW += enthalpy;
      } else {
        s.mdotLowerKgPerS += m;
        s.qLowerW += enthalpy;
      }
    }
    // Species ledger (Requirement 8.4): between layers, to the exterior, or from the exterior with ambient composition.
    if (fromC !== undefined && toC !== undefined) {
      recordTransfer(ws, nodeOf(fromC, t.fromLayer), nodeOf(toC, t.toLayer), m);
    } else if (fromC !== undefined) {
      const k = nodeOf(fromC, t.fromLayer);
      ledger.exteriorOutKgPerS[k] = (ledger.exteriorOutKgPerS[k] as number) + m;
    } else if (toC !== undefined) {
      const k = nodeOf(toC, t.toLayer);
      for (let s = 0; s < SPECIES_COUNT; s++) {
        const i = k * SPECIES_COUNT + s;
        ledger.sourceKgPerS[i] = (ledger.sourceKgPerS[i] as number) + m * (model.ambientSpeciesFractions[s] as number);
      }
    }
  }
}
function addSpeciesSource(ws: Workspace, node: number, species: number, kgPerS: number): void {
  const i = node * SPECIES_COUNT + species;
  ws.ledger.sourceKgPerS[i] = (ws.ledger.sourceKgPerS[i] as number) + kgPerS;
}
// Design Gas state module and Requirement 3.1: gas properties of one compartment at the trial state, and the end state
// that the vent modules read. Eq. 2.4 gives the densities from the absolute pressure at the floor.
function fillGasState(ws: Workspace, c: CompartmentModel, y: Float64Array): void {
  const b = VARS_PER_COMPARTMENT * c.index;
  const p = y[b + VAR_P] as number;
  const vuRaw = y[b + VAR_VU] as number;
  const tu = y[b + VAR_TU] as number;
  const tl = c.isShaft ? tu : (y[b + VAR_TL] as number); // a shaft has one temperature
  // Requirement 3.6: all physics is evaluated with Vu clamped to [VMIN, VMAX].
  const vu = Math.min(Math.max(vuRaw, c.vminM3), c.vmaxM3);
  const vl = lowerVolumeM3(vu, c.volumeM3);
  const pAbs = c.ambientFloorPressurePa + p;
  const rhoU = pAbs / (GAS_R_J_PER_KG_K * tu); // Tech Ref eq. 2.4
  const rhoL = pAbs / (GAS_R_J_PER_KG_K * tl);
  const e = ws.ends[c.index] as VerticalVentEndState;
  e.interfaceHeightM = interfaceHeightM(c.heightM, vu, c.floorAreaM2); // Requirement 3.4
  e.floorPressurePa = p + c.ambientFloorRelativePa; // relative to the common reference, as CFAST relp
  e.upperTempK = tu;
  e.lowerTempK = tl;
  e.upperDensityKgPerM3 = rhoU;
  e.lowerDensityKgPerM3 = rhoL;
  e.upperVolumeM3 = vu;
  e.lowerVolumeM3 = vl;
  ws.upperDepthM[c.index] = vu / c.floorAreaM2;
  ws.lowerMassKg[c.index] = rhoL * vl; // Tech Ref eq. 2.4: m = P V / (R T)
  ws.lowerDensityKgPerM3[c.index] = rhoL;
  const s = ws.sources[c.index] as LayerSourceTerms;
  s.qUpperW = 0;
  s.qLowerW = 0;
  s.mdotUpperKgPerS = 0;
  s.mdotLowerKgPerS = 0;
}
function layerAbsorption(
  ws: Workspace,
  c: CompartmentModel,
  node: number,
  tempK: number,
  volumeM3: number,
  depthM: number,
): number {
  const sp = ws.species.speciesKg;
  const o = node * SPECIES_COUNT;
  return layerAbsorptionPerM({
    tempK,
    volumeM3,
    depthM,
    floorAreaM2: c.floorAreaM2,
    widthM: c.widthM,
    roomDepthM: c.depthM,
    co2MassKg: sp[o + SPECIES_CO2] as number,
    h2oMassKg: sp[o + SPECIES_H2O] as number,
    sootMassKg: sp[o + SPECIES_SOOT] as number,
  });
}
// Fires of one compartment: Tech Ref eq. 3.1 to 3.21, design Fire modules. Adds the convective heat, the mass and
// enthalpy of the plume and the species sources to the upper layer, and fills the radiation sources.
// Returns the largest convective heat release rate of any fire in the room (ceiling jet, CFAST convection.f90).
function evaluateCompartmentFires(model: Model, ws: Workspace, c: CompartmentModel, t: number): number {
  const radFires = ws.radFires[c.index] as RadiationFire[];
  radFires.length = 0;
  let maxConvectiveW = 0;
  const src = ws.sources[c.index] as LayerSourceTerms;
  const e = ws.ends[c.index] as VerticalVentEndState;
  const upperNode = layerNode(c.index, LAYER_UPPER);
  const lowerNode = c.isShaft ? upperNode : layerNode(c.index, LAYER_LOWER);
  for (const fi of c.fires) {
    const fm = model.fires[fi];
    if (fm === undefined) continue;
    const drive = fireDrive(fm.fire, t, model.adiabatic);
    const ev = evaluateFire({
      fire: fm.fire,
      drive,
      room: c,
      upperLayerDepthM: ws.upperDepthM[c.index] as number,
      lowerTempK: e.lowerTempK,
      upperTempK: e.upperTempK,
      lowerMassKg: ws.lowerMassKg[c.index] as number,
      minLowerMassKg: c.vminM3 * (ws.lowerDensityKgPerM3[c.index] as number),
      o2Lower: massFraction(ws.species, lowerNode, SPECIES_O2),
      o2Upper: massFraction(ws.species, upperNode, SPECIES_O2),
      interiorAmbientTempK: model.interiorTempK,
      cfastUpperPlumeArgOrder: model.cfastUpperPlumeArgOrder,
    });
    ws.fireEvals[fi] = ev;
    maxConvectiveW = Math.max(maxConvectiveW, ev.convectiveW);
    // Design Fire modules step 8, CFAST 7.7.7 source, fire.f90 (fire): mass to the upper layer is the pyrolysis rate
    // plus the entrained air, energy is the convective heat plus the enthalpy of the unburned fuel and of the entrained air.
    const mE = ev.entrainmentKgS;
    src.mdotUpperKgPerS += ev.pyrolysisKgS + mE;
    src.mdotLowerKgPerS -= mE;
    src.qUpperW +=
      ev.convectiveW +
      CP_J_PER_KG_K * ev.unburnedFuelKgS * model.interiorTempK +
      CP_J_PER_KG_K * mE * e.lowerTempK;
    src.qLowerW -= CP_J_PER_KG_K * mE * e.lowerTempK;
    recordTransfer(ws, lowerNode, upperNode, mE);
    const r = ev.upperLayerRates;
    addSpeciesSource(ws, upperNode, SPECIES_O2, r.o2);
    addSpeciesSource(ws, upperNode, SPECIES_CO2, r.co2);
    addSpeciesSource(ws, upperNode, SPECIES_CO, r.co);
    addSpeciesSource(ws, upperNode, SPECIES_H2O, r.h2o);
    addSpeciesSource(ws, upperNode, SPECIES_SOOT, r.soot);
    // v1 does not track HCl and HCN (Requirement 8.1). Their mass, zero unless the fuel has Cl or fuel N yields, is kept
    // with the inert N2 so that the layer mass balance stays closed. The validator warns about such input.
    addSpeciesSource(ws, upperNode, SPECIES_N2, r.n2 + r.hcl + r.hcn);
    addSpeciesSource(ws, upperNode, SPECIES_UHC, r.fuel);
    if (ev.radiativeW > 0) {
      radFires.push({
        xM: fm.fire.xM,
        yM: fm.fire.yM,
        baseZM: drive.heightM,
        flameHeightM: flameHeightM(ev.hrrW, drive.areaM2), // Tech Ref eq. 3.19 via CFAST flame_height
        radiativeW: ev.radiativeW,
      });
    }
  }
  return maxConvectiveW;
}
// Back-face flux of one surface from the lagged (accepted) back-face temperature.
function backFlux(model: Model, ws: Workspace, c: CompartmentModel, s: number): number {
  const prof = ws.current[c.index * SURFACE_COUNT + s] as Float64Array;
  const back = prof[prof.length - 1] as number;
  const kind = (c.surfaces[s] as { horizontal: boolean }).horizontal ? "horizontal" : "wall";
  return backFaceFlux(kind, model.exteriorTempK, back);
}
// Surfaces of one compartment: radiation (Tech Ref eq. 5.1 to 5.20), convection (5.22, 5.23, ceiling jet), conduction
// residual (eq. 2.9, 5.27) and the heat they take from or give to the layers. Writes the four surface rows of `ws.rhs`.
function evaluateCompartmentSurfaces(
  model: Model,
  ws: Workspace,
  c: CompartmentModel,
  y: Float64Array,
  t: number,
  maxConvectiveW: number,
): void {
  const b = VARS_PER_COMPARTMENT * c.index;
  const e = ws.ends[c.index] as VerticalVentEndState;
  const src = ws.sources[c.index] as LayerSourceTerms;
  const tu = e.upperTempK;
  const tl = e.lowerTempK;
  const temps = ws.radSurfaceTemp[c.index] as number[];
  for (let s = 0; s < SURFACE_COUNT; s++) {
    const sm = c.surfaces[s];
    const gas = sm?.upperGas === true ? tu : tl;
    // An adiabatic surface follows the gas next to it (design Heat transfer modules).
    temps[s] = sm?.adiabaticMarker === true ? gas : (y[b + VAR_TW + s] as number);
  }
  const zI = e.interfaceHeightM;
  const upperNode = layerNode(c.index, LAYER_UPPER);
  const lowerNode = c.isShaft ? upperNode : layerNode(c.index, LAYER_LOWER);
  const depthU = ws.upperDepthM[c.index] as number;
  const rad = surfaceRadiation({
    widthM: c.widthM,
    depthM: c.depthM,
    heightM: c.heightM,
    interfaceHeightM: zI,
    upperTempK: tu,
    lowerTempK: tl,
    surfaceTempK: temps,
    emissivity: ws.radEmissivity[c.index] as number[],
    upperAbsorptionPerM: layerAbsorption(ws, c, upperNode, tu, e.upperVolumeM3, depthU),
    lowerAbsorptionPerM: layerAbsorption(ws, c, lowerNode, tl, e.lowerVolumeM3, e.lowerVolumeM3 / c.floorAreaM2),
    fires: ws.radFires[c.index] as RadiationFire[],
  });
  src.qUpperW += rad.absorbedUpperW;
  src.qLowerW += rad.absorbedLowerW;
  const dt = Math.max(t - ws.profileTimeS, 0);
  const wallUpperM2 = c.wallPerimeterM * (c.heightM - zI);
  const wallLowerM2 = c.wallPerimeterM * zI;
  for (let s = 0; s < SURFACE_COUNT; s++) {
    const sm = c.surfaces[s];
    if (sm === undefined) continue;
    const gas = sm.upperGas ? tu : tl;
    const row = b + VAR_TW + s;
    if (sm.adiabaticMarker) {
      ws.rhs[row] = (y[row] as number) - gas; // algebraic: the surface follows the gas, no heat is exchanged
      continue;
    }
    const tw = y[row] as number;
    const kind = sm.horizontal ? "horizontal" : "wall";
    let convective = convectiveFlux(kind, gas, tw);
    let area = s === SURFACE_UPPER_WALL ? wallUpperM2 : s === SURFACE_LOWER_WALL ? wallLowerM2 : c.floorAreaM2;
    if (s === SURFACE_CEILING) {
      const cc = ceilingConvection(convective, c.floorAreaM2, maxConvectiveW, c.widthM, c.depthM, c.heightM);
      convective = cc.fluxWPerM2;
      area = cc.areaM2;
    }
    const net = convective + (rad.fluxToSurfaceWPerM2[s] as number);
    const k = c.index * SURFACE_COUNT + s;
    const gradient = surfaceGradient(
      ws.grids[k] ?? null,
      model.adiabatic,
      ws.current[k] ?? null,
      ws.trial[k] ?? null,
      tw,
      dt,
      backFlux(model, ws, c, s),
    ).gradientKPerM;
    ws.rhs[row] = conductionResidual(net, gradient, sm.k1WPerMK);
    // Heat that the layer gives to the surface by convection (radiation is in the layer absorption above).
    if (sm.upperGas) src.qUpperW -= convective * area;
    else src.qLowerW -= convective * area;
  }
}
// Layer mixing: CFAST 7.7.7 source, compartments.f90, layer_mixing. Not in a shaft (one zone).
function evaluateLayerMixing(ws: Workspace, c: CompartmentModel): void {
  if (c.isShaft) return;
  const e = ws.ends[c.index] as VerticalVentEndState;
  if (!(e.lowerTempK > e.upperTempK)) return;
  const lowerNode = layerNode(c.index, LAYER_LOWER);
  const o = lowerNode * SPECIES_COUNT;
  const mix = layerMixing({
    upperTempK: e.upperTempK,
    lowerTempK: e.lowerTempK,
    ceilingAreaM2: c.floorAreaM2,
    lowerMassKg: ws.lowerMassKg[c.index] as number,
    lowerDensityKgPerM3: ws.lowerDensityKgPerM3[c.index] as number,
    minLayerVolumeM3: c.vminM3,
    lowerSpeciesMassKg: ws.species.speciesKg.subarray(o, o + SPECIES_COUNT),
  });
  const src = ws.sources[c.index] as LayerSourceTerms;
  src.qUpperW += mix.energyUpperW;
  src.qLowerW -= mix.energyUpperW;
  src.mdotUpperKgPerS += mix.massUpperKgPerS;
  src.mdotLowerKgPerS -= mix.massUpperKgPerS;
  recordTransfer(ws, lowerNode, layerNode(c.index, LAYER_UPPER), mix.massUpperKgPerS);
}
function endState(ws: Workspace, v: number, comp: number, partner: number): VerticalVentEndState {
  if (comp >= 0) return ws.ends[comp] as VerticalVentEndState;
  // Outside end: follows the partner compartment (outsideEnd copies the partner's floor, height and interface).
  const out = ws.outsideEnds[v] as VerticalVentEndState;
  const p = ws.ends[partner] as VerticalVentEndState;
  out.interfaceHeightM = p.interfaceHeightM;
  out.upperVolumeM3 = p.upperVolumeM3;
  out.lowerVolumeM3 = p.lowerVolumeM3;
  return out;
}
// Vent flows of Tech Ref chapters 4 (eq. 4.1 to 4.14) and section 4.4 (leakage).
function evaluateVent(model: Model, ws: Workspace, vi: number, vent: VentModel, t: number): void {
  const [a, b] = vent.ends;
  const partner = a >= 0 ? a : b;
  const end0 = endState(ws, vi, a, partner);
  const end1 = endState(ws, vi, b, partner);
  let result: VentFlowResult;
  if (vent.kind === "wall") {
    const g = ws.wallGeometry[vi] as WallVentGeometry;
    g.openFraction = openFractionAt(vent.open, t);
    result = wallVentFlows(g, end0, end1);
  } else if (vent.kind === "ceilingFloor") {
    const g = ws.ceilingGeometry[vi] as CeilingFloorVentGeometry;
    g.openFraction = openFractionAt(vent.open, t);
    result = ceilingFloorVentFlows(g, end0, end1, { interiorAmbientTempK: model.interiorTempK });
  } else {
    result = leakageFlows(vent.geometry, end0, end1);
  }
  ws.ventResults[vi] = result;
  applyTransfers(model, ws, result.transfers, a, b);
}
// Evaluates the whole model at (t, y): gas sources, fires, radiation, convection, conduction, vents, mixing and the
// right-hand sides of eq. 2.5 to 2.9. Fills `ws.rhs`, `ws.fireEvals`, `ws.ventResults` and the species ledger.
export function evaluateModel(model: Model, ws: Workspace, t: number, y: Float64Array): void {
  const ledger = ws.ledger;
  ledger.count = 0;
  ledger.exteriorOutKgPerS.fill(0);
  ledger.sourceKgPerS.fill(0);
  for (const c of model.compartments) fillGasState(ws, c, y);
  for (const c of model.compartments) {
    const maxConvectiveW = evaluateCompartmentFires(model, ws, c, t);
    evaluateCompartmentSurfaces(model, ws, c, y, t, maxConvectiveW);
    evaluateLayerMixing(ws, c);
  }
  model.vents.forEach((v, i) => evaluateVent(model, ws, i, v, t));
  for (const c of model.compartments) {
    const b = VARS_PER_COMPARTMENT * c.index;
    const e = ws.ends[c.index] as VerticalVentEndState;
    const s = ws.sources[c.index] as LayerSourceTerms;
    if (c.isShaft) {
      // CFAST 7.7.7 source, solve.f90: all flows of the lower layer are added to the upper layer.
      const m = mergeShaftFlows({
        qUpperW: s.qUpperW,
        qLowerW: s.qLowerW,
        mdotUpperKgPerS: s.mdotUpperKgPerS,
        mdotLowerKgPerS: s.mdotLowerKgPerS,
      });
      s.qUpperW = m.qUpperW;
      s.qLowerW = m.qLowerW;
      s.mdotUpperKgPerS = m.mdotUpperKgPerS;
      s.mdotLowerKgPerS = m.mdotLowerKgPerS;
    }
    const st = ws.layerState;
    st.pressurePa = c.ambientFloorPressurePa + (y[b + VAR_P] as number);
    st.upperVolumeM3 = e.upperVolumeM3;
    st.upperTempK = e.upperTempK;
    st.lowerTempK = e.lowerTempK;
    layerDerivatives(c.volumeM3, e.lowerVolumeM3, st, s, ws.deriv);
    ws.rhs[b + VAR_P] = ws.deriv[0] as number;
    // Requirement 5.8: a shaft keeps Vu constant and Tl equal to Tu.
    ws.rhs[b + VAR_VU] = c.isShaft ? 0 : (ws.deriv[1] as number);
    ws.rhs[b + VAR_TU] = ws.deriv[2] as number;
    ws.rhs[b + VAR_TL] = c.isShaft ? (ws.deriv[2] as number) : (ws.deriv[3] as number);
  }
}
// Residual F(t, y, y') for the solver (Tech Ref eq. C.1, C.2).
export function createResidual(model: Model, ws: Workspace): ResidualFn {
  return (t, y, yp, out) => {
    evaluateModel(model, ws, t, y);
    for (let c = 0; c < model.compartments.length; c++) {
      const b = VARS_PER_COMPARTMENT * c;
      for (let v = 0; v <= VAR_TL; v++) out[b + v] = (yp[b + v] as number) - (ws.rhs[b + v] as number);
      for (let s = 0; s < SURFACE_COUNT; s++) out[b + VAR_TW + s] = ws.rhs[b + VAR_TW + s] as number;
    }
  };
}
// Tech Ref 5.4: after an accepted step, the profile solved from the accepted surface temperature becomes the current
// profile. Surfaces that are adiabatic (marker or option) have no profile to update.
export function commitWalls(model: Model, ws: Workspace, t: number, y: Float64Array): void {
  const dt = Math.max(t - ws.profileTimeS, 0);
  if (!model.adiabatic) {
    for (const c of model.compartments) {
      for (let s = 0; s < SURFACE_COUNT; s++) {
        const k = c.index * SURFACE_COUNT + s;
        const grid = ws.grids[k];
        if (grid === null || grid === undefined) continue;
        const cur = ws.current[k] as Float64Array;
        const tri = ws.trial[k] as Float64Array;
        stepConduction(grid, cur, tri, y[VARS_PER_COMPARTMENT * c.index + VAR_TW + s] as number, dt, backFlux(model, ws, c, s));
        commitProfile(tri, cur);
      }
    }
  }
  ws.profileTimeS = t;
}
// Species flows of the last `evaluateModel` call, in the form of the species tracker (design Species_Tracker step 1).
export function collectSpeciesFlows(ws: Workspace): SpeciesFlows {
  const l = ws.ledger;
  const transfers: LayerTransfer[] = [];
  for (let i = 0; i < l.count; i++) {
    transfers.push({ from: l.from[i] as number, to: l.to[i] as number, kgPerS: l.kgPerS[i] as number });
  }
  return { transfers, exteriorOutKgPerS: l.exteriorOutKgPerS, sourceKgPerS: l.sourceKgPerS };
}
