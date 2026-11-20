// Room-and-door evacuation model with decision points.
// People walk in straight lines inside a room between door positions, queue at doors that pass at most
// 1.3 persons per metre of clear width per second (SFPE specific flow, secondary source), and take stair flights at
// stair speed. At each decision point the Policy picks one of the options the model lists, so a decision can never
// name a door that does not exist.
import type { Result } from "../fire";
import { createPrng } from "../fire/prng";
import { doorState, type DrillScenario } from "../plan/scenario";
import { OUTSIDE, type Door, type Plan, type Room } from "../plan/types";
import { coDosePerS, HazardField, heatDosePerS, smokeLevel, smokeSpeedFactor } from "./hazard";
import { PERSONAS, type Persona } from "./personas";
import {
  STATE,
  type Action,
  type AgentSummary,
  type CrowdResult,
  type Decision,
  type DecisionOption,
  type DecisionRequest,
  type DecisionSource,
  type DoorStat,
  type Policy,
  type Trigger,
} from "./types";

const DT = 0.5;
const FRAME_DT = 1;
const FLOW_P_PER_M_S = 1.3;
const MAX_DECISIONS_PER_AGENT = 8;
// People make up their minds on a 2 s beat: a short reaction time, and it lets everyone deciding at about the same
// moment be asked in one go.
const DECIDE_EVERY_S = 2;
const GUIDE_S = 20;

const NAMES = ["Alex", "Sam", "Priya", "Tom", "Mei", "Jordan", "Fatima", "Liam", "Rosa", "Kofi", "Hannah", "Omar", "Grace", "Dev", "Nina", "Ben", "Aisha", "Leo", "Maya", "Ravi", "Chloe", "Ivan", "Zara", "Jack", "Sofia", "Noah", "Elif", "Owen", "Yuki", "Ella", "Marco", "Amara", "Finn", "Lucia", "Tariq", "Ruby", "Hugo", "Ines", "Kai", "Mary"];

interface Agent {
  id: number;
  name: string;
  persona: Persona;
  room: string;
  x: number;
  y: number;
  floor: number;
  state: number;
  preMoveEnd: number;
  path: string[]; // doors still to pass
  goal: { kind: "exit" } | { kind: "room"; roomId: string } | null;
  busyUntil: number;
  busyKind: "guide" | "wait" | null;
  transitDoor: string | null;
  transitUntil: number;
  known: Set<string>;
  knownLocked: Set<string>;
  heatDose: number;
  coDose: number;
  summary: AgentSummary;
  asked: Set<string>; // one-off prompts already given: smoke per room, "guided", "shelter:<room>", "ahead:<room>"
  lastShelterAsk: number;
  pending: boolean;
  queuedAt: string | null;
}

interface DoorRt {
  d: Door;
  state: Door["state"];
  queue: number[];
  credit: number;
  stat: DoorStat;
}

export interface CrowdOptions {
  maxAiCalls?: number; // decisions beyond this go to the standard rules and are marked "fallback"
  onProgress?: (simTimeS: number, durationS: number) => void;
  fallback: Policy;
}

export async function runCrowd(plan: Plan, s: DrillScenario, fire: Result | null, policy: Policy, opt: CrowdOptions): Promise<CrowdResult> {
  const rng = createPrng(s.seed);
  const hazard = new HazardField(fire);
  const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
  const doors = new Map<string, DoorRt>(
    plan.doors.map((d) => [d.id, { d, state: doorState(d, s), queue: [], credit: 0, stat: { doorId: d.id, passed: 0, maxQueue: 0, firstUseS: null, lastUseS: null } }]),
  );
  const doorsOf = new Map<string, Door[]>();
  for (const d of plan.doors) {
    for (const end of [d.a, d.b]) if (end !== OUTSIDE) doorsOf.set(end, [...(doorsOf.get(end) ?? []), d]);
  }
  const other = (d: Door, roomId: string) => (d.a === roomId ? d.b : d.a);
  const isExit = (d: Door) => d.a === OUTSIDE || d.b === OUTSIDE;
  const publicDoor = (d: Door) => {
    const ra = rooms.get(d.a);
    const rb = d.b === OUTSIDE ? undefined : rooms.get(d.b);
    if (ra?.staffOnly || rb?.staffOnly) return false;
    return !isExit(d) || !!d.mainEntrance || !!d.exitSign;
  };

  // People
  const agents: Agent[] = [];
  for (const g of s.occupants) {
    const room = rooms.get(g.room);
    if (!room) continue;
    const persona = PERSONAS[g.kind];
    for (let i = 0; i < g.count; i++) {
      const id = agents.length;
      const [lo, hi] = persona.preMovementS;
      const known = new Set(plan.doors.filter((d) => persona.knowsAllExits || publicDoor(d)).map((d) => d.id));
      for (const d of doorsOf.get(room.id) ?? []) known.add(d.id);
      const name = `${NAMES[id % NAMES.length]}${id >= NAMES.length ? " " + (Math.floor(id / NAMES.length) + 1) : ""}`;
      agents.push({
        id, name, persona, room: room.id,
        x: room.x + 0.4 + rng() * (room.widthM - 0.8), y: room.y + 0.4 + rng() * (room.depthM - 0.8), floor: room.floor,
        state: STATE.premove, preMoveEnd: s.alarmDelayS + lo + rng() * (hi - lo),
        path: [], goal: null, busyUntil: 0, busyKind: null, transitDoor: null, transitUntil: 0,
        known, knownLocked: new Set(), heatDose: 0, coDose: 0, asked: new Set(), lastShelterAsk: -1e9, pending: false, queuedAt: null,
        summary: { id, name, persona: g.kind, startRoom: room.name, outcome: "inside", timeS: null, exitDoor: null, peakHeatDose: 0, peakCoDose: 0, cause: null, smokeS: 0, worstTempC: 20, worstVisM: 30, worstRoom: null, decisions: [] },
      });
    }
  }

  const active = (a: Agent) => a.state !== STATE.out && a.state !== STATE.incapacitated;
  const speedIn = (a: Agent, roomId: string, t: number) => a.persona.speedMS * smokeSpeedFactor(hazard.at(roomId, t).visibilityM);
  const cap = (dr: DoorRt) => FLOW_P_PER_M_S * dr.d.widthM * (dr.state === "closed" ? 0.8 : 1);

  // Fastest route over doors the person knows about. Returns the door list and an ETA, or null.
  function route(a: Agent, t: number, target: (d: Door, into: string) => boolean, avoid?: string): { path: string[]; eta: number; cost: number } | null {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    const via = new Map<string, string>(); // door -> room we arrive in after passing it
    const open: [string, number][] = [];
    const time = new Map<string, number>(); // walking time without the avoidance penalties, for the ETA we show
    const usable = (d: Door) => a.known.has(d.id) && !a.knownLocked.has(d.id) && d.id !== avoid;
    const room0 = rooms.get(a.room)!;
    for (const d of doorsOf.get(a.room) ?? []) {
      if (!usable(d)) continue;
      const tt = Math.hypot(d.x - a.x, d.y - a.y) / speedIn(a, room0.id, t) + queueWait(d.id) + (d.stair ? d.stair.lengthM / a.persona.stairSpeedMS : 0);
      const c = tt + smokeCost(room0.id, t);
      const into0 = other(d, a.room);
      const c0 = c + (into0 !== OUTSIDE ? fireCost(into0, t) : 0);
      time.set(d.id, tt);
      dist.set(d.id, c0); prev.set(d.id, null); via.set(d.id, into0); open.push([d.id, c0]);
    }
    let best: { door: string; cost: number; time: number } | null = null;
    while (open.length) {
      open.sort((p, q) => p[1] - q[1]);
      const [did, c] = open.shift()!;
      if (c > (dist.get(did) ?? Infinity)) continue;
      const d = doors.get(did)!.d;
      const into = via.get(did)!;
      if (target(d, into)) { if (!best || c < best.cost) best = { door: did, cost: c, time: time.get(did)! }; continue; }
      if (into === OUTSIDE) continue;
      const r = rooms.get(into)!;
      for (const n of doorsOf.get(into) ?? []) {
        if (n.id === did || !usable(n)) continue;
        let leg = Math.hypot(n.x - d.x, n.y - d.y) / speedIn(a, r.id, t);
        if (n.stair) leg += n.stair.lengthM / a.persona.stairSpeedMS;
        const nInto = other(n, into);
        const nc = c + leg + queueWait(n.id) + smokeCost(r.id, t) + (nInto !== OUTSIDE ? fireCost(nInto, t) : 0);
        if (nc < (dist.get(n.id) ?? Infinity)) { time.set(n.id, time.get(did)! + leg + queueWait(n.id)); dist.set(n.id, nc); prev.set(n.id, did); via.set(n.id, other(n, into)); open.push([n.id, nc]); }
      }
    }
    if (!best) return null;
    const path: string[] = [];
    for (let cur: string | null = best.door; cur; cur = prev.get(cur) ?? null) path.unshift(cur);
    return { path, eta: best.time, cost: best.cost };
  }
  function queueWait(doorId: string) {
    const dr = doors.get(doorId)!;
    return dr.queue.length / cap(dr);
  }
  // People avoid walking into the room that is on fire once it is clearly burning; they still can if it is the only way.
  function fireCost(roomId: string, t: number) {
    return roomId === s.fire.room && t >= (s.fire.startS ?? 0) + 20 ? 120 : 0;
  }
  function smokeCost(roomId: string, t: number) {
    const lvl = smokeLevel(hazard.at(roomId, t));
    return lvl === "thick" ? 60 : lvl === "light" ? 10 : 0;
  }
  const exitTarget = (d: Door, into: string) => into === OUTSIDE && isExit(d);

  function doorLabel(d: Door, from?: string) {
    if (isExit(d)) return d.mainEntrance ? `the main entrance (${d.id})` : d.exitSign ? `the signed fire exit ${d.id}` : `the unmarked door ${d.id} to the outside`;
    const to = rooms.get(from ? other(d, from) : d.b);
    return `door ${d.id} to ${to?.name ?? "?"}`;
  }

  function buildRequest(a: Agent, t: number, trigger: Trigger, triggerText: string): DecisionRequest {
    const here = hazard.at(a.room, t);
    const room = rooms.get(a.room)!;
    const opts: DecisionOption[] = [];
    const letters = "ABCDEFGH";
    const add = (action: Action, label: string, notes: string[], etaS?: number) => {
      if (opts.length < letters.length) opts.push({ id: letters[opts.length]!, action, label, notes, ...(etaS !== undefined ? { etaS: Math.round(etaS) } : {}) });
    };
    // One option per exit the person can reach.
    const exits = plan.doors.filter((d) => isExit(d));
    const routes: { d: Door; r: { path: string[]; eta: number; cost: number } }[] = [];
    for (const ex of exits) {
      const r = route(a, t, (d, into) => d.id === ex.id && into === OUTSIDE);
      if (r) routes.push({ d: ex, r });
    }
    routes.sort((p, q) => p.r.cost - q.r.cost); // best first: quick, and away from smoke and the fire
    for (const { d, r } of routes.slice(0, 4)) {
      const roomsOnWay: string[] = [];
      let cur = a.room;
      for (const id of r.path) { const dd = doors.get(id)!.d; cur = other(dd, cur); if (cur !== OUTSIDE) roomsOnWay.push(cur); }
      const notes: string[] = [];
      const q = doors.get(r.path[0]!)!.queue.length + doors.get(d.id)!.queue.length;
      if (q > 0) notes.push(`${q} people queueing on the way`);
      for (const rid of roomsOnWay) { const lvl = smokeLevel(hazard.at(rid, t)); if (lvl !== "clear") notes.push(`${lvl} smoke in ${rooms.get(rid)!.name}`); }
      if (roomsOnWay.includes(s.fire.room) || a.room === s.fire.room) notes.push("passes through the room where the fire is");
      if (d.state === "closed") notes.push("the exit door is shut");
      const way = roomsOnWay.length ? ` through ${roomsOnWay.map((rid) => rooms.get(rid)!.name).join(", ")}` : "";
      add({ kind: "go_exit", doorId: d.id }, `Head for ${doorLabel(d)}${way}`, notes, r.eta);
    }
    // Follow someone already moving in the same room.
    const movers = agents.filter((b) => b.id !== a.id && b.room === a.room && active(b) && (b.state === STATE.moving || b.state === STATE.queue) && b.goal?.kind === "exit");
    if (movers.length) {
      const leader = movers.find((b) => b.persona.kind === "staff") ?? movers[0]!;
      const last = leader.path[leader.path.length - 1];
      add({ kind: "follow", leaderId: leader.id }, `Follow ${leader.persona.kind === "staff" ? "a member of staff" : "the people around you"}${last ? " towards " + doorLabel(doors.get(last)!.d) : ""}`, [`${movers.length} people in this room are already leaving`]);
    }
    // Staff can tell people the way out.
    const unaware = agents.filter((b) => b.id !== a.id && b.room === a.room && active(b) && !b.persona.knowsAllExits && !b.asked.has("guided"));
    if (a.persona.kind === "staff" && unaware.length) add({ kind: "guide" }, `Stop for ${GUIDE_S} s and show the ${unaware.length} people here every way out`, []);
    if (a.persona.kind === "staff") {
      for (const r of plan.rooms) {
        if (r.id === a.room) continue;
        const n = agents.filter((b) => b.room === r.id && b.state === STATE.premove).length;
        const rr = n ? route(a, t, (_d, into) => into === r.id) : null;
        if (n && rr && opts.length < 7) add({ kind: "go_room", roomId: r.id }, `Go to ${r.name} and warn the ${n} people there`, smokeLevel(hazard.at(r.id, t)) !== "clear" ? ["smoke there"] : [], rr.eta);
      }
    }
    if (trigger === "alarm") add({ kind: "wait", seconds: 30 }, "Wait 30 s to see whether it is a real fire", []);
    // Staying put is only on the table when getting out looks bad: no exit, smoke on every route, a person who cannot
    // use the stairs, or after finding a door locked or smoke ahead.
    const exitOpts = opts.filter((o) => o.action.kind === "go_exit");
    const allSmoky = exitOpts.length > 0 && exitOpts.every((o) => o.notes.some((n) => n.includes("smoke") || n.includes("fire is")));
    const canShelter = a.room !== s.fire.room && room.kind !== "corridor" &&
      (exitOpts.length === 0 || allSmoky || a.persona.kind === "mobility_impaired" || trigger === "blocked" || trigger === "smoke_ahead" || trigger === "smoke");
    if (canShelter) add({ kind: "shelter" }, room.kind === "stair" ? "Wait here in the stair for the fire service to help" : "Stay in this room, shut the door and wait for the fire service", here.visibilityM < 10 ? ["smoke is already in this room"] : []);
    const obs: string[] = [];
    if (t >= s.alarmDelayS) obs.push("the fire alarm is sounding");
    const lvl = smokeLevel(here);
    if (lvl !== "clear") obs.push(`${lvl} smoke in this room (you can see about ${Math.max(0.5, Math.round(here.visibilityM))} m)`);
    if (here.tempC > 35) obs.push(`it is hot here (${Math.round(here.tempC)} °C)`);
    if (a.knownLocked.size) obs.push(`you found ${[...a.knownLocked].join(", ")} locked`);
    return {
      agentId: a.id, name: a.name, persona: a.persona.kind, personaText: a.persona.description, trigger, triggerText, timeS: Math.round(t),
      roomId: a.room, roomName: room.name, smokeHere: lvl, tempC: Math.round(here.tempC),
      peopleHere: agents.filter((b) => b.room === a.room && active(b)).length, observations: obs, options: opts,
    };
  }

  let aiCalls = 0;
  const bySource: Record<DecisionSource, number> = { standard: 0, on_device: 0, cloud: 0, fallback: 0 };
  const maxAi = opt.maxAiCalls ?? Infinity;

  async function decideAll(reqs: { a: Agent; req: DecisionRequest }[], t: number) {
    if (!reqs.length) return;
    const useAi: typeof reqs = [];
    const rules: typeof reqs = [];
    for (const r of reqs) {
      if (r.req.options.length <= 1) rules.push(r);
      else if (policy.name !== opt.fallback.name && aiCalls + useAi.length < maxAi && r.a.summary.decisions.length < MAX_DECISIONS_PER_AGENT) useAi.push(r);
      else rules.push(r);
    }
    const out: Decision[] = [];
    if (useAi.length) {
      aiCalls += useAi.length;
      try {
        out.push(...(await policy.decide(useAi.map((r) => r.req))));
      } catch {
        rules.push(...useAi);
      }
    }
    const missing = reqs.filter((r) => !out.some((d) => d.agentId === r.a.id));
    if (missing.length) {
      const fb = await opt.fallback.decide(missing.map((r) => r.req));
      const isFallback = policy.name !== opt.fallback.name;
      out.push(...fb.map((d) => ({ ...d, source: (isFallback && missing.some((m) => m.a.id === d.agentId && m.req.options.length > 1) ? "fallback" : "standard") as DecisionSource })));
    }
    for (const { a, req } of reqs) {
      a.pending = false;
      const dcs = out.find((d) => d.agentId === a.id);
      const o = req.options.find((x) => x.id === dcs?.optionId) ?? req.options[0];
      if (!o) { a.state = STATE.sheltering; continue; }
      bySource[dcs?.source ?? "standard"]++;
      a.summary.decisions.push({ timeS: Math.round(t), trigger: req.trigger, roomName: req.roomName, chosen: o.label, reason: dcs?.reason ?? "", source: dcs?.source ?? "standard", optionCount: req.options.length });
      apply(a, o.action, t);
    }
  }

  function setPath(a: Agent, r: { path: string[] } | null, goal: Agent["goal"]) {
    if (!r || !r.path.length) { a.state = STATE.sheltering; a.goal = null; a.path = []; return; }
    a.path = [...r.path]; a.goal = goal; a.state = STATE.moving;
  }

  function leaveQueue(a: Agent) {
    if (!a.queuedAt) return;
    const dr = doors.get(a.queuedAt)!;
    dr.queue = dr.queue.filter((x) => x !== a.id);
    a.queuedAt = null;
  }

  function apply(a: Agent, act: Action, t: number) {
    // A new choice replaces whatever the person was doing, including waiting in a door queue.
    leaveQueue(a);
    switch (act.kind) {
      case "go_exit":
        setPath(a, route(a, t, (d, into) => d.id === act.doorId && into === OUTSIDE) ?? route(a, t, exitTarget), { kind: "exit" });
        break;
      case "follow": {
        const l = agents[act.leaderId];
        if (l && l.room === a.room && l.path.length) { for (const id of l.path) a.known.add(id); setPath(a, route(a, t, (d, into) => d.id === l.path[l.path.length - 1] && into === OUTSIDE), { kind: "exit" }); }
        else setPath(a, route(a, t, exitTarget), { kind: "exit" });
        break;
      }
      case "shelter": a.state = STATE.sheltering; a.path = []; a.goal = null; a.lastShelterAsk = t; break;
      case "guide":
        a.state = STATE.busy; a.busyKind = "guide"; a.busyUntil = t + GUIDE_S; a.path = [];
        break;
      case "wait": a.state = STATE.busy; a.busyKind = "wait"; a.busyUntil = t + act.seconds; a.path = []; break;
      case "go_room": setPath(a, route(a, t, (_d, into) => into === act.roomId), { kind: "room", roomId: act.roomId }); break;
    }
  }

  // Main loop
  const frames: Float32Array[] = [];
  let t = 0;
  let nextFrame = 0;
  const reqs: { a: Agent; req: DecisionRequest }[] = [];
  const ask = (a: Agent, trig: Trigger, text: string) => {
    if (a.pending) return;
    a.pending = true;
    reqs.push({ a, req: buildRequest(a, t, trig, text) });
  };

  while (t <= s.durationS) {
    // Doses
    for (const a of agents) {
      if (!active(a)) continue;
      const e = hazard.at(a.room, t);
      // What each person goes through, kept even when the doses stay below the limits (stairs included).
      if (e.visibilityM < 3 || e.tempC >= 60) a.summary.smokeS += DT;
      if (Math.round(e.tempC) > a.summary.worstTempC) { a.summary.worstTempC = Math.round(e.tempC); a.summary.worstRoom = a.room; }
      a.summary.worstVisM = Math.min(a.summary.worstVisM, Math.round(e.visibilityM * 10) / 10);
      if (a.state === STATE.transit) continue;
      a.heatDose += heatDosePerS(e.tempC) * DT;
      a.coDose += coDosePerS(e.coPpm) * DT;
      a.summary.peakHeatDose = a.heatDose; a.summary.peakCoDose = a.coDose;
      if (a.heatDose >= 1 || a.coDose >= 1) {
        a.state = STATE.incapacitated; a.summary.outcome = "incapacitated"; a.summary.timeS = Math.round(t); a.summary.cause = a.heatDose >= 1 ? "heat" : "co";
        leaveQueue(a);
      }
    }
    // Triggers
    for (const a of agents) {
      if (!active(a) || a.pending) continue;
      if (a.state === STATE.premove && t >= a.preMoveEnd) ask(a, "alarm", "The fire alarm has gone off and you have noticed it.");
      else if (a.state === STATE.busy && t >= a.busyUntil) {
        if (a.busyKind === "guide") {
          for (const b of agents) if (b.room === a.room && b.id !== a.id && active(b)) {
            for (const d of plan.doors) b.known.add(d.id);
            if (b.asked.has("guided")) continue; // already shown the way once; asked again it would only repeat itself
            b.asked.add("guided");
            if (b.state !== STATE.premove && b.state !== STATE.transit) ask(b, "guided", "A member of staff has just shown you every way out of the building.");
            else if (b.state === STATE.premove) b.preMoveEnd = Math.min(b.preMoveEnd, t);
          }
        }
        a.busyKind = null;
        ask(a, "waited", "You have finished what you stopped to do.");
      } else if (a.state === STATE.sheltering && t - a.lastShelterAsk > 30 && !a.asked.has(`shelter:${a.room}`) && smokeLevel(hazard.at(a.room, t)) === "thick") {
        // Asked once per room: someone who decides to stay put in smoke is not asked again every minute.
        a.asked.add(`shelter:${a.room}`); ask(a, "smoke", "Thick smoke is now coming into the room where you are waiting.");
      } else if ((a.state === STATE.moving) && !a.asked.has(a.room) && smokeLevel(hazard.at(a.room, t)) === "thick") {
        a.asked.add(a.room); ask(a, "smoke", "You are in thick smoke and can barely see.");
      }
    }
    const decideNow = Math.abs(t / DECIDE_EVERY_S - Math.round(t / DECIDE_EVERY_S)) < 1e-6;
    if (reqs.length && decideNow) { await decideAll(reqs.splice(0), t); }

    // Movement
    for (const a of agents) {
      if (!active(a)) continue;
      if (a.state === STATE.transit) {
        if (t >= a.transitUntil) { a.state = STATE.moving; a.transitDoor = null; if (!a.path.length) arrive(a); }
        continue;
      }
      if (a.state !== STATE.moving) continue;
      const did = a.path[0];
      if (!did) { arrive(a); continue; }
      const dr = doors.get(did)!;
      const dx = dr.d.x - a.x, dy = dr.d.y - a.y;
      const dist = Math.hypot(dx, dy);
      const step = speedIn(a, a.room, t) * DT;
      if (dist > step) { a.x += (dx / dist) * step; a.y += (dy / dist) * step; continue; }
      a.x = dr.d.x; a.y = dr.d.y;
      if (dr.state === "locked") {
        a.knownLocked.add(did);
        ask(a, "blocked", `You reached ${doorLabel(dr.d, a.room)} and it will not open.`);
        a.state = STATE.busy; a.busyUntil = Infinity; a.busyKind = null;
        continue;
      }
      const next = other(dr.d, a.room);
      if (next !== OUTSIDE && !a.asked.has("ahead:" + next) && smokeLevel(hazard.at(next, t)) === "thick" && a.room !== next) {
        a.asked.add("ahead:" + next);
        ask(a, "smoke_ahead", `Through ${doorLabel(dr.d, a.room)} you can see thick smoke in ${rooms.get(next)!.name}.`);
        a.state = STATE.busy; a.busyUntil = Infinity; a.busyKind = null;
        continue;
      }
      a.state = STATE.queue; a.queuedAt = did; dr.queue.push(a.id);
      dr.stat.maxQueue = Math.max(dr.stat.maxQueue, dr.queue.length);
    }
    if (reqs.length && decideNow) await decideAll(reqs.splice(0), t);
    // Doors let people through
    for (const dr of doors.values()) {
      if (!dr.queue.length) { dr.credit = Math.min(1, dr.credit + cap(dr) * DT); continue; }
      dr.credit += cap(dr) * DT;
      while (dr.credit >= 1 && dr.queue.length) {
        dr.credit -= 1;
        const a = agents[dr.queue.shift()!]!;
        if (a.state !== STATE.queue || a.queuedAt !== dr.d.id) { dr.credit += 1; continue; } // left the queue already
        a.queuedAt = null;
        pass(a, dr, t);
      }
    }
    // Frames
    if (t >= nextFrame) {
      const f = new Float32Array(agents.length * 4);
      agents.forEach((a, i) => {
        let x = a.x, y = a.y;
        if (a.state === STATE.queue) { x += Math.sin(a.id * 7.1) * 0.35; y += Math.cos(a.id * 3.3) * 0.35; }
        f[i * 4] = x; f[i * 4 + 1] = y; f[i * 4 + 2] = a.floor; f[i * 4 + 3] = a.state;
      });
      frames.push(f);
      nextFrame += FRAME_DT;
      opt.onProgress?.(t, s.durationS);
    }
    if (agents.every((a) => !active(a) || (a.state === STATE.sheltering && smokeLevel(hazard.at(a.room, t)) !== "thick" && t > s.durationS - 1))) break;
    if (agents.every((a) => !active(a))) break;
    t += DT;
  }

  function pass(a: Agent, dr: DoorRt, tNow: number) {
    dr.stat.passed++;
    dr.stat.firstUseS ??= Math.round(tNow);
    dr.stat.lastUseS = Math.round(tNow);
    a.path.shift();
    const next = other(dr.d, a.room);
    if (next === OUTSIDE) {
      a.state = STATE.out; a.summary.outcome = "out"; a.summary.timeS = Math.round(tNow); a.summary.exitDoor = dr.d.id;
      a.x = dr.d.x; a.y = dr.d.y;
      return;
    }
    const r: Room = rooms.get(next)!;
    a.room = next; a.floor = r.floor;
    for (const d of doorsOf.get(next) ?? []) a.known.add(d.id);
    if (dr.d.stair) {
      a.state = STATE.transit; a.transitDoor = dr.d.id; a.transitUntil = tNow + dr.d.stair.lengthM / a.persona.stairSpeedMS;
    } else a.state = STATE.moving;
    // step just inside the room
    a.x = Math.min(r.x + r.widthM - 0.2, Math.max(r.x + 0.2, a.x));
    a.y = Math.min(r.y + r.depthM - 0.2, Math.max(r.y + 0.2, a.y));
    if (!a.path.length && a.state === STATE.moving) arrive(a);
  }

  function arrive(a: Agent) {
    if (a.goal?.kind === "room" && a.room === a.goal.roomId) {
      for (const b of agents) if (b.room === a.room && b.state === STATE.premove) b.preMoveEnd = Math.min(b.preMoveEnd, t + 5);
      a.goal = null;
      a.state = STATE.busy; a.busyUntil = t; a.busyKind = null;
      ask(a, "arrived", `You have reached ${rooms.get(a.room)!.name} and warned the people there.`);
      return;
    }
    // Path ran out without reaching an exit: plan again.
    a.state = STATE.busy; a.busyUntil = t; a.busyKind = null;
  }

  for (const a of agents) {
    if (a.state === STATE.sheltering) a.summary.outcome = "sheltering";
    else if (active(a)) a.summary.outcome = "inside";
  }
  return {
    policy: policy.name, frameDtS: FRAME_DT, frames, agents: agents.map((a) => a.summary), doors: [...doors.values()].map((d) => d.stat),
    endTimeS: Math.round(t), aiCalls, decisionsBySource: bySource,
  };
}

