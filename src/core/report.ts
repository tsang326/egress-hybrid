// Plain facts about a run, for the screen and for the models. Every number here comes from the simulation.
import type { CrowdResult } from "./crowd/types";
import { HazardField, smokeLevel } from "./crowd/hazard";
import { PERSONAS } from "./crowd/personas";
import type { Result } from "./fire";
import { fireItem } from "./plan/fireItems";
import type { DrillScenario } from "./plan/scenario";
import { OUTSIDE, type Plan } from "./plan/types";

export interface Fix { door_id: string; change: "unlock" | "keep_open" | "add_exit_sign" | "widen"; why: string }

export interface RunFacts {
  total: number;
  out: number;
  incapacitated: number;
  sheltering: number;
  inside: number;
  lastOutS: number | null;
  medianOutS: number | null;
  smokeLoggedS: { roomId: string; name: string; timeS: number }[]; // first time thick smoke at head height
}

export function runFacts(plan: Plan, fire: Result | null, crowd: CrowdResult): RunFacts {
  const n = (o: string) => crowd.agents.filter((a) => a.outcome === o).length;
  const outs = crowd.agents.filter((a) => a.outcome === "out").map((a) => a.timeS!).sort((a, b) => a - b);
  const hz = new HazardField(fire);
  const smokeLoggedS: RunFacts["smokeLoggedS"] = [];
  if (fire) for (const r of plan.rooms) {
    for (let t = 0; t <= (fire.timesS[fire.timesS.length - 1] ?? 0); t += 5) {
      if (smokeLevel(hz.at(r.id, t)) === "thick") { smokeLoggedS.push({ roomId: r.id, name: r.name, timeS: t }); break; }
    }
  }
  return {
    total: crowd.agents.length, out: n("out"), incapacitated: n("incapacitated"), sheltering: n("sheltering"), inside: n("inside"),
    lastOutS: outs.length ? outs[outs.length - 1]! : null, medianOutS: outs.length ? outs[Math.floor(outs.length / 2)]! : null,
    smokeLoggedS: smokeLoggedS.sort((a, b) => a.timeS - b.timeS),
  };
}

export function factsText(plan: Plan, s: DrillScenario, fire: Result | null, crowd: CrowdResult): string {
  const f = runFacts(plan, fire, crowd);
  const name = (id: string) => (id === OUTSIDE ? "outside" : plan.rooms.find((r) => r.id === id)?.name ?? id);
  const lines: string[] = [];
  const item = fireItem(s.fire.item);
  lines.push(`Fire: ${item.label} in ${name(s.fire.room)}, peak ${item.peakKW} kW (${item.source === "measured" ? "measured curve" : "design estimate"}). Alarm after ${s.alarmDelayS} s.`);
  if (s.lockedDoors.length) lines.push(`Doors that could not be used: ${s.lockedDoors.map((d) => { const dd = plan.doors.find((x) => x.id === d); return dd ? `${d} (${name(dd.a)} to ${name(dd.b)})` : d; }).join(", ")}.`);
  lines.push(`People: ${f.total}. Got out: ${f.out}. Overcome by heat or smoke: ${f.incapacitated}. Still sheltering in a room: ${f.sheltering}. Still inside, moving: ${f.inside}.`);
  if (f.lastOutS !== null) lines.push(`Half of those who got out were out by ${f.medianOutS} s; the last one at ${f.lastOutS} s.`);
  if (f.smokeLoggedS.length) lines.push(`Thick smoke at head height: ${f.smokeLoggedS.map((x) => `${x.name} from ${x.timeS} s`).join(", ")}.`);
  const used = crowd.doors.filter((d) => d.passed > 0).sort((a, b) => b.passed - a.passed);
  lines.push(`Doors used: ${used.map((d) => { const dd = plan.doors.find((x) => x.id === d.doorId)!; return `${d.doorId} ${name(dd.a)}-${name(dd.b)}: ${d.passed} people, longest queue ${d.maxQueue}`; }).join("; ")}.`);
  const unused = plan.doors.filter((d) => (d.a === OUTSIDE || d.b === OUTSIDE) && !used.some((u) => u.doorId === d.id));
  if (unused.length) lines.push(`Exits nobody used: ${unused.map((d) => `${d.id} from ${name(d.a)}${d.exitSign ? " (signed)" : " (no sign)"}${s.lockedDoors.includes(d.id) ? " (locked)" : ""}`).join(", ")}.`);
  const harmed = crowd.agents.filter((a) => a.outcome === "incapacitated" || a.outcome === "sheltering");
  for (const a of harmed.slice(0, 8)) {
    const last = a.decisions[a.decisions.length - 1];
    lines.push(`- ${a.name} (${PERSONAS[a.persona].label}, started in ${a.startRoom}): ${a.outcome === "incapacitated" ? `overcome by ${a.cause === "co" ? "carbon monoxide" : "heat"} at ${a.timeS} s` : "still sheltering at the end"}${last ? `; last choice "${last.chosen}" in ${last.roomName}` : ""}.`);
  }
  if (harmed.length > 8) lines.push(`- and ${harmed.length - 8} more.`);
  return lines.join("\n");
}

/** Applies suggested fixes to a copy of the plan and scenario, so the app can re-run and check them. */
export function applyFixes(plan: Plan, s: DrillScenario, fixes: Fix[]): { plan: Plan; scenario: DrillScenario; applied: string[] } {
  const p: Plan = structuredClone(plan);
  const sc: DrillScenario = structuredClone(s);
  const applied: string[] = [];
  for (const fx of fixes) {
    const d = p.doors.find((x) => x.id === fx.door_id);
    if (!d) continue;
    if (fx.change === "unlock") { sc.lockedDoors = sc.lockedDoors.filter((x) => x !== d.id); if (d.state === "locked") d.state = "closed"; applied.push(`Unlock ${d.id}`); }
    if (fx.change === "keep_open") { sc.lockedDoors = sc.lockedDoors.filter((x) => x !== d.id); sc.closedDoors = (sc.closedDoors ?? []).filter((x) => x !== d.id); d.state = "open"; applied.push(`Keep ${d.id} open`); }
    if (fx.change === "add_exit_sign") { d.exitSign = true; applied.push(`Lit exit sign on ${d.id}`); }
    if (fx.change === "widen") { d.widthM = Math.min(2.4, d.widthM + 0.6); applied.push(`Widen ${d.id} to ${d.widthM.toFixed(1)} m`); }
  }
  return { plan: p, scenario: sc, applied };
}
