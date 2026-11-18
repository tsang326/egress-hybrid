// Building plan used by the editor, the crowd model and the fire model.
// Coordinates are metres on each floor's plan, x to the right, y downwards (as on a drawn plan).

export const OUTSIDE = "OUTSIDE";

export type RoomKind = "room" | "corridor" | "stair";

export interface Room {
  id: string;
  name: string;
  floor: number; // 0 = ground floor
  x: number;
  y: number;
  widthM: number; // along x
  depthM: number; // along y
  heightM: number;
  kind: RoomKind;
  staffOnly?: boolean; // customers do not know their way through this room
}

export type DoorState = "open" | "closed" | "locked";

export interface Door {
  id: string;
  a: string; // room id
  b: string; // room id or OUTSIDE
  widthM: number;
  x: number; // centre of the opening on the plan of room a's floor
  y: number;
  state: DoorState; // locked = nobody can pass; closed = people can pass, smoke mostly cannot
  exitSign?: boolean; // a lit fire-exit sign that strangers can follow
  mainEntrance?: boolean; // the door customers came in by
  stair?: { lengthM: number }; // a flight between two stair rooms on different floors
}

export interface Plan {
  schemaVersion: 1;
  title: string;
  floorHeightM: number;
  rooms: Room[];
  doors: Door[];
}

export function roomById(plan: Plan, id: string): Room | undefined {
  return plan.rooms.find((r) => r.id === id);
}

export function floorsOf(plan: Plan): number[] {
  return [...new Set(plan.rooms.map((r) => r.floor))].sort((a, b) => a - b);
}

/** Problems a user must fix before a run. Empty when the plan can be simulated. */
export function checkPlan(plan: Plan): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const r of plan.rooms) {
    if (ids.has(r.id)) out.push(`Two rooms share the id "${r.id}".`);
    ids.add(r.id);
    if (!(r.widthM > 0.5 && r.depthM > 0.5)) out.push(`${r.name} is smaller than 0.5 m.`);
    if (!(r.heightM >= 2 && r.heightM <= 12)) out.push(`${r.name} needs a height between 2 and 12 m.`);
  }
  for (const d of plan.doors) {
    if (!ids.has(d.a)) out.push(`Door ${d.id} starts in a room that does not exist.`);
    if (d.b !== OUTSIDE && !ids.has(d.b)) out.push(`Door ${d.id} leads to a room that does not exist.`);
    if (d.a === d.b) out.push(`Door ${d.id} connects a room to itself.`);
    if (!(d.widthM >= 0.5 && d.widthM <= 6)) out.push(`Door ${d.id} needs a width between 0.5 and 6 m.`);
  }
  if (!plan.doors.some((d) => d.b === OUTSIDE || d.a === OUTSIDE)) out.push("The plan has no door to the outside.");
  return out;
}
