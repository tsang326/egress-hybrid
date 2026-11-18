// A drill scenario on a plan: where the fire starts, which doors are unusable, who is in the building.
import type { Compartment, Scenario as FireScenario, Surface, Vent } from "../fire";
import { fireItem, hrrTable } from "./fireItems";
import { OUTSIDE, roomById, type Door, type Plan, type Room } from "./types";

export type PersonaKind = "customer" | "staff" | "elderly" | "parent_with_child" | "mobility_impaired";

export interface OccupantGroup {
  room: string;
  count: number;
  kind: PersonaKind;
}

export interface DrillScenario {
  fire: { room: string; item: string; startS?: number };
  lockedDoors: string[]; // doors nobody can use in this drill (blocked, locked, chained)
  closedDoors?: string[]; // doors that are shut but usable
  occupants: OccupantGroup[];
  alarmDelayS: number; // time from ignition to the alarm
  durationS: number;
  seed: number;
}

// A shut door still leaks around its frame. 5 % of the opening is more than a real gap, but smaller fractions make the
// fire solver stall on pressure differences near zero (seen with 0 and 0.01 on the office sample), so 5 % it is.
export const SHUT_DOOR_OPEN_FRACTION = 0.05;

export function doorState(d: Door, s: DrillScenario): Door["state"] {
  if (s.lockedDoors.includes(d.id)) return "locked";
  if (s.closedDoors?.includes(d.id)) return "closed";
  return d.state;
}

const GYPSUM: Surface = {
  layers: [{ name: "gypsum board", conductivityWPerMK: 0.16, densityKgPerM3: 790, specificHeatJPerKgK: 900, thicknessM: 0.016, emissivity: 0.9 }],
};
const CONCRETE: Surface = {
  layers: [{ name: "concrete", conductivityWPerMK: 1.75, densityKgPerM3: 2200, specificHeatJPerKgK: 1000, thicknessM: 0.15, emissivity: 0.94 }],
};

/** Which wall of room r a door at (x, y) sits on, and its offset along that wall. */
export function doorFace(r: Room, d: Door): { face: "front" | "back" | "left" | "right"; offsetM: number; wallLenM: number } {
  const dist = { front: Math.abs(d.y - r.y), back: Math.abs(d.y - (r.y + r.depthM)), left: Math.abs(d.x - r.x), right: Math.abs(d.x - (r.x + r.widthM)) };
  const face = (Object.keys(dist) as (keyof typeof dist)[]).reduce((a, b) => (dist[a] <= dist[b] ? a : b));
  const along = face === "front" || face === "back";
  const wallLenM = along ? r.widthM : r.depthM;
  const centre = along ? d.x - r.x : d.y - r.y;
  const w = Math.min(d.widthM, wallLenM);
  const offsetM = Math.max(0, Math.min(wallLenM - w, centre - w / 2));
  return { face, offsetM, wallLenM };
}

/** Builds the two-zone fire model input. Each room is one compartment; each door is a wall vent; stairs are floor vents. */
export function toFireScenario(plan: Plan, s: DrillScenario): FireScenario {
  const compartments: Compartment[] = plan.rooms.map((r) => ({
    id: r.id,
    widthM: r.widthM,
    depthM: r.depthM,
    heightM: r.heightM,
    floorElevationM: r.floor * plan.floorHeightM,
    kind: r.kind === "stair" ? "shaft" : r.kind === "corridor" ? "corridor" : "room",
    ...(r.kind === "stair" ? { isStair: true } : {}),
    ceiling: CONCRETE,
    floor: CONCRETE,
    walls: GYPSUM,
    leakage: { wallAreaRatio: 1.7e-4 },
  }));
  const vents: Vent[] = [];
  for (const d of plan.doors) {
    const ra = roomById(plan, d.a);
    if (!ra) continue;
    const state = doorState(d, s);
    if (d.stair) {
      const rb = roomById(plan, d.b);
      if (!rb) continue;
      const [lower, upper] = ra.floor < rb.floor ? [ra, rb] : [rb, ra];
      const side = Math.min(lower.widthM, lower.depthM, 1.5);
      vents.push({ kind: "ceilingFloor", id: d.id, lower: lower.id, upper: upper.id, areaM2: side * side, shape: "square", open: 1 });
      continue;
    }
    const { face, offsetM, wallLenM } = doorFace(ra, d);
    const soffit = Math.min(2.1, ra.heightM);
    const open = state === "open" ? 1 : SHUT_DOOR_OPEN_FRACTION;
    vents.push({ kind: "wall", id: d.id, from: d.a, to: d.b === OUTSIDE ? OUTSIDE : d.b, sillM: 0, soffitM: soffit, widthM: Math.min(d.widthM, wallLenM), face, offsetM, open });
  }
  const room = roomById(plan, s.fire.room) ?? plan.rooms[0]!;
  const item = fireItem(s.fire.item);
  return {
    schemaVersion: 1,
    title: plan.title,
    durationS: s.durationS,
    printIntervalS: 5,
    seed: s.seed,
    ambient: { interiorTempK: 293.15, exteriorTempK: 288.15, pressurePa: 101325, species: { o2: 0.2315, co2: 0.0006, co: 0, h2o: 0.007, soot: 0 } },
    compartments,
    vents,
    fires: [
      {
        id: "fire",
        compartmentId: room.id,
        xM: room.widthM / 2,
        yM: room.depthM / 2,
        radiativeFraction: 0.35,
        ...(s.fire.startS ? { ignitionTimeS: s.fire.startS } : {}),
        fuel: item.fuel,
        table: hrrTable(item),
      },
    ],
  };
}
