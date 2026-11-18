// Turning a rough reading (rooms with positions, doors with a side) into a plan with doors placed on real walls.
import { OUTSIDE, type Door, type Plan, type Room } from "./types";

export interface RoughRoom { id: string; name: string; floor: number; x: number; y: number; widthM: number; depthM: number; kind: Room["kind"]; staffOnly: boolean }
export interface RoughDoor { from: string; to: string; widthM: number; side: "top" | "bottom" | "left" | "right"; isExit: boolean; exitSign: boolean; mainEntrance: boolean }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "room";

/** Shared stretch of wall between two rooms on the same floor, or null when they do not touch. */
export function sharedWall(a: Room, b: Room, tol = 0.6): { x: number; y: number; lengthM: number } | null {
  if (a.floor !== b.floor) return null;
  const ax2 = a.x + a.widthM, ay2 = a.y + a.depthM, bx2 = b.x + b.widthM, by2 = b.y + b.depthM;
  const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const overlapY = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (Math.abs(ax2 - b.x) < tol || Math.abs(bx2 - a.x) < tol) {
    if (overlapY <= 0.5) return null;
    const x = Math.abs(ax2 - b.x) < tol ? (ax2 + b.x) / 2 : (bx2 + a.x) / 2;
    return { x, y: Math.max(a.y, b.y) + overlapY / 2, lengthM: overlapY };
  }
  if (Math.abs(ay2 - b.y) < tol || Math.abs(by2 - a.y) < tol) {
    if (overlapX <= 0.5) return null;
    const y = Math.abs(ay2 - b.y) < tol ? (ay2 + b.y) / 2 : (by2 + a.y) / 2;
    return { x: Math.max(a.x, b.x) + overlapX / 2, y, lengthM: overlapX };
  }
  return null;
}

function sidePoint(r: Room, side: RoughDoor["side"], k: number): { x: number; y: number } {
  const f = 0.3 + 0.4 * ((k * 0.618) % 1); // spread several doors on one wall
  switch (side) {
    case "top": return { x: r.x + r.widthM * f, y: r.y };
    case "bottom": return { x: r.x + r.widthM * f, y: r.y + r.depthM };
    case "left": return { x: r.x, y: r.y + r.depthM * f };
    case "right": return { x: r.x + r.widthM, y: r.y + r.depthM * f };
  }
}

/** Lays rooms out in a row when a reading has no usable positions (all at 0,0 or overlapping heavily). */
function fixPositions(rooms: RoughRoom[]): RoughRoom[] {
  const byFloor = new Map<number, RoughRoom[]>();
  for (const r of rooms) byFloor.set(r.floor, [...(byFloor.get(r.floor) ?? []), r]);
  const out: RoughRoom[] = [];
  for (const [, rs] of byFloor) {
    let overlaps = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!, b = rs[j]!;
      const ox = Math.min(a.x + a.widthM, b.x + b.widthM) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.depthM, b.y + b.depthM) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) overlaps++;
    }
    if (overlaps === 0) { out.push(...rs); continue; }
    let x = 0;
    for (const r of rs) { out.push({ ...r, x, y: 0 }); x += r.widthM; }
  }
  return out;
}

export function planFromRough(title: string, roughRooms: RoughRoom[], roughDoors: RoughDoor[], floorHeightM = 3.2): { plan: Plan; notes: string[] } {
  const notes: string[] = [];
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const rooms: Room[] = fixPositions(roughRooms).map((r) => {
    let id = slug(r.id || r.name);
    while (used.has(id)) id += "_2";
    used.add(id);
    ids.set(r.id, id);
    ids.set(r.name, id);
    return {
      id, name: r.name || id, floor: Math.max(0, Math.round(r.floor)), x: Math.max(0, r.x), y: Math.max(0, r.y),
      widthM: Math.min(60, Math.max(1, r.widthM)), depthM: Math.min(60, Math.max(1, r.depthM)), heightM: r.kind === "stair" ? floorHeightM : 3,
      kind: r.kind, ...(r.staffOnly ? { staffOnly: true } : {}),
    };
  });
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const doors: Door[] = [];
  const perWall = new Map<string, number>();
  roughDoors.forEach((d) => {
    const a = byId.get(ids.get(d.from) ?? slug(d.from));
    const toOutside = d.isExit || d.to.toUpperCase() === OUTSIDE;
    const b = toOutside ? undefined : byId.get(ids.get(d.to) ?? slug(d.to));
    if (!a || (!toOutside && !b)) { notes.push(`Skipped a door between "${d.from}" and "${d.to}": room not found.`); return; }
    if (b && b.id === a.id) return;
    const id = `D${doors.length + 1}`;
    const width = Math.min(4, Math.max(0.7, d.widthM || 0.9));
    if (b && a.kind === "stair" && b.kind === "stair" && a.floor !== b.floor) {
      doors.push({ id, a: a.id, b: b.id, widthM: width, x: a.x + a.widthM / 2, y: a.y + a.depthM / 2, state: "open", stair: { lengthM: 3 * Math.abs(a.floor - b.floor) * floorHeightM } });
      return;
    }
    let pt: { x: number; y: number };
    if (b) {
      const w = sharedWall(a, b);
      if (w) pt = { x: w.x, y: w.y };
      else { notes.push(`${a.name} and ${b.name} do not share a wall on the plan; the door was put on ${a.name}'s ${d.side} wall.`); pt = sidePoint(a, d.side, 0); }
    } else {
      const k = `${a.id}:${d.side}`;
      const n = perWall.get(k) ?? 0;
      perWall.set(k, n + 1);
      pt = sidePoint(a, d.side, n);
    }
    doors.push({ id, a: a.id, b: b ? b.id : OUTSIDE, widthM: width, x: pt.x, y: pt.y, state: "open", ...(d.exitSign ? { exitSign: true } : {}), ...(d.mainEntrance ? { mainEntrance: true } : {}) });
  });
  if (doors.length && !doors.some((d) => d.mainEntrance)) {
    const first = doors.find((d) => d.b === OUTSIDE);
    if (first) { first.mainEntrance = true; notes.push(`No main entrance was marked; ${first.id} was taken as the main entrance.`); }
  }
  return { plan: { schemaVersion: 1, title: title || "Imported plan", floorHeightM, rooms, doors }, notes };
}
