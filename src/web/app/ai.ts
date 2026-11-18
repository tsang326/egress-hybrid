// What the app asks the models to do. Each task names where it runs and why.
import type { Decision, DecisionRequest, Policy } from "../../core/crowd/types";
import { FIRE_ITEMS } from "../../core/plan/fireItems";
import type { DrillScenario, PersonaKind } from "../../core/plan/scenario";
import { OUTSIDE, type Plan } from "../../core/plan/types";
import type { Fix } from "../../core/report";
import { CLOUD_MODEL, CLOUD_VISION_MODEL, jsonModel, textModel, type Where } from "./firebase";

export type Source = "on_device" | "cloud";
export interface Answer<T> { value: T; source: Source; ms: number }

function sourceOf(res: { response: { inferenceSource?: string } }): Source {
  return res.response.inferenceSource === "on_device" || res.response.inferenceSource === "ON_DEVICE" ? "on_device" : "cloud";
}

// The free Gemini tier allows a limited number of requests per minute. Keep under it on our side, and when the
// service still says 429, wait and try again rather than dropping the question.
const CLOUD_PER_MINUTE = 12;
const sent: number[] = [];
async function cloudSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0]! > 60000) sent.shift();
    if (sent.length < CLOUD_PER_MINUTE) { sent.push(now); return; }
    await new Promise((r) => setTimeout(r, 60000 - (now - sent[0]!) + 50));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls a model with the rate limit and retries above. Device calls go straight through. */
async function call<R>(where: Where, run: (fallbackModel: boolean) => Promise<R>, canFallBack: boolean): Promise<R> {
  if (where === "device") return run(false);
  let fallback = false;
  for (let attempt = 0; ; attempt++) {
    await cloudSlot();
    try {
      return await run(fallback);
    } catch (e) {
      const m = String(e);
      if (attempt >= 2) throw e;
      if (/\b429\b|quota|exhausted/i.test(m)) { await sleep(20000); continue; }
      if (/\b(500|503)\b|high demand|overloaded|abort|timeout/i.test(m)) { if (canFallBack) fallback = true; await sleep(1500); continue; }
      throw e;
    }
  }
}

async function askJson<T>(where: Where, key: string, schema: Record<string, unknown>, parts: (string | { inlineData: { mimeType: string; data: string } })[], opts: { image?: boolean; cloudModel?: string; timeoutMs?: number } = {}): Promise<Answer<T>> {
  const t0 = performance.now();
  const content = parts.map((p) => (typeof p === "string" ? { type: "text" as const, text: p } : { type: "inlineData" as const, ...p }));
  const canFallBack = !!opts.cloudModel && opts.cloudModel !== CLOUD_MODEL; // a busy larger model falls back to the lighter one
  const res = await call(where, (fb) => jsonModel(where, key + (fb ? CLOUD_MODEL : opts.cloudModel ?? ""), schema, { ...opts, ...(fb ? { cloudModel: CLOUD_MODEL } : {}) }).generateContent(content), canFallBack);
  const text = res.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return { value: JSON.parse(text) as T, source: sourceOf(res), ms: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Reading a photo of an evacuation plan. Cloud by default (the on-device model reads labels well but gets the
//    door connections wrong in our tests); "device" keeps the photo on the computer.

export interface PlanReading {
  title: string;
  floors: number;
  rooms: { id: string; name: string; floor: number; x: number; y: number; width_m: number; depth_m: number; kind: "room" | "corridor" | "stair"; staff_only: boolean }[];
  doors: { from: string; to: string; width_m: number; is_exit: boolean; side: "top" | "bottom" | "left" | "right"; exit_sign: boolean; main_entrance: boolean }[];
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    floors: { type: "integer" },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" }, floor: { type: "integer" },
          x: { type: "number" }, y: { type: "number" }, width_m: { type: "number" }, depth_m: { type: "number" },
          kind: { type: "string", enum: ["room", "corridor", "stair"] }, staff_only: { type: "boolean" },
        },
        required: ["id", "name", "floor", "x", "y", "width_m", "depth_m", "kind", "staff_only"],
      },
    },
    doors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" }, to: { type: "string" }, width_m: { type: "number" }, is_exit: { type: "boolean" },
          side: { type: "string", enum: ["top", "bottom", "left", "right"] }, exit_sign: { type: "boolean" }, main_entrance: { type: "boolean" },
        },
        required: ["from", "to", "width_m", "is_exit", "side", "exit_sign", "main_entrance"],
      },
    },
  },
  required: ["title", "floors", "rooms", "doors"],
};

const PLAN_PROMPT = `You are reading a photo or drawing of a building plan (often a fire evacuation plan).
Return every room and every door as JSON.
Rooms: a short id (lowercase, no spaces), the name written on the plan, the floor (0 = ground), the top-left corner x,y in metres
from the top-left of that floor's plan, width (left-right) and depth (top-bottom) in metres. Use dimensions written on the plan;
otherwise estimate from a scale bar or from typical door width (0.9 m). kind is "stair" for stairs, "corridor" for corridors
and halls, else "room". staff_only is true for kitchens, stores, plant rooms and offices behind the counter in shops and cafés.
Doors: gaps or door symbols in walls. from = a room id, to = another room id, or "${OUTSIDE}" for doors to the outside. side is the
wall of the "from" room the door is on. width in metres (0.9 if not written). is_exit for doors to the outside. exit_sign when a
fire-exit sign or running-man symbol marks it. main_entrance for the public entrance. For stairs on several floors, give one
stair room per floor with the same x,y and a door between the two stair rooms.`;

export async function readPlanPhoto(where: Where, image: { mimeType: string; base64: string }): Promise<Answer<PlanReading>> {
  return askJson<PlanReading>(where, "plan", PLAN_SCHEMA, [PLAN_PROMPT, { inlineData: { mimeType: image.mimeType, data: image.base64 } }], { image: true, cloudModel: CLOUD_VISION_MODEL, timeoutMs: 60000 });
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Turning a sentence into a drill scenario. On the device: it is short, it is repeated often, and the user edits it.

export interface ScenarioReading {
  fire_room: string;
  fire_item: string;
  locked_doors: string[];
  occupants: { room: string; count: number; kind: PersonaKind }[];
  alarm_delay_s: number;
}

export function scenarioSchema(plan: Plan) {
  return {
    type: "object",
    properties: {
      fire_room: { type: "string", enum: plan.rooms.map((r) => r.id) },
      fire_item: { type: "string", enum: FIRE_ITEMS.map((f) => f.id) },
      locked_doors: { type: "array", items: { type: "string", enum: plan.doors.map((d) => d.id) } },
      occupants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            room: { type: "string", enum: plan.rooms.map((r) => r.id) },
            count: { type: "integer" },
            kind: { type: "string", enum: ["customer", "staff", "resident", "elderly", "parent_with_child", "mobility_impaired"] },
          },
          required: ["room", "count", "kind"],
        },
      },
      alarm_delay_s: { type: "integer" },
    },
    required: ["fire_room", "fire_item", "locked_doors", "occupants", "alarm_delay_s"],
  };
}

export function describePlan(plan: Plan): string {
  const rooms = plan.rooms.map((r) => `${r.id} = ${r.name}${r.floor ? ` (floor ${r.floor})` : ""}`).join("; ");
  const doors = plan.doors.map((d) => `${d.id} = ${plan.rooms.find((r) => r.id === d.a)?.name ?? d.a} to ${d.b === OUTSIDE ? "outside" : plan.rooms.find((r) => r.id === d.b)?.name ?? d.b}${d.mainEntrance ? " (main entrance)" : ""}${d.stair ? " (stairs)" : ""}`).join("; ");
  return `Rooms: ${rooms}.\nDoors: ${doors}.`;
}

const SCENARIO_RULES = `Turn the drill description into JSON for this building.
Rules:
- locked_doors: only doors the description says are locked, blocked, chained or unusable. If it says nothing about doors, use [].
- occupants: one entry per group of people and room. "customers", "guests", "visitors", "diners" are customer; "staff",
  "waiters", "cooks", "employees", "cleaner" are staff; "residents", "tenants", "flatmates", people asleep in their own bedrooms are resident; "elderly", "older" people are elderly; "families", "parents with kids"
  are parent_with_child; "wheelchair user" is mobility_impaired. Put people in the room the description says; if it does not
  say, put customers in the main public room and staff where they normally work.
- fire_item: the closest item from the list. Bins and rubbish are trash_bin. Boxes and stock are stored_boxes.
- alarm_delay_s: seconds from the start of the fire to the alarm. 30 unless the description says otherwise
  ("no alarm" or "the alarm is broken" means 180).
Fire items: ${FIRE_ITEMS.map((f) => `${f.id} (${f.label})`).join(", ")}.
Example: "Chip pan fire in the kitchen, 30 diners and 2 cooks, the fire exit is chained" ->
{"fire_room":"<kitchen id>","fire_item":"deep_fryer","locked_doors":["<fire exit id>"],"occupants":[{"room":"<dining id>","count":30,"kind":"customer"},{"room":"<kitchen id>","count":2,"kind":"staff"}],"alarm_delay_s":30}`;

export async function parseScenario(where: Where, plan: Plan, text: string): Promise<Answer<ScenarioReading>> {
  return askJson<ScenarioReading>(where, `scenario:${plan.title}:${plan.rooms.length}:${plan.doors.length}`, scenarioSchema(plan), [
    `${SCENARIO_RULES}\n\n${describePlan(plan)}\n\nDescription: ${text}`,
  ]);
}

export function toDrill(r: ScenarioReading, base: DrillScenario): DrillScenario {
  return {
    ...base,
    fire: { room: r.fire_room, item: r.fire_item },
    lockedDoors: [...new Set(r.locked_doors)],
    occupants: r.occupants.filter((o) => o.count > 0).map((o) => ({ room: o.room, count: Math.min(300, o.count), kind: o.kind })),
    alarmDelayS: Math.max(0, Math.min(600, r.alarm_delay_s)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. People deciding what to do. Many small calls per run: on the device they cost nothing and stay private.

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group: { type: "integer" },
          split: {
            type: "array",
            items: {
              type: "object",
              properties: { option: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H"] }, people: { type: "integer" }, reason: { type: "string" } },
              required: ["option", "people", "reason"],
            },
          },
        },
        required: ["group", "split"],
      },
    },
  },
  required: ["groups"],
};

const DECISION_RULES = `You decide what real people would most likely do during a building fire. Not the ideal choice: what people
like these, knowing only what they know, would actually do. People usually head for the way they came in, follow others or staff,
hesitate when they are unsure, and avoid thick smoke if they can see another way. Staff tend to help customers first.
Each group is one or more people in the same place and situation. Split each group's people across the options (the counts must
add up to the group size; a group of 1 gets exactly one option). For each option you use, give a reason of at most 12 words,
written about the people ("she...", "they...").`;

interface Group { id: number; reqs: DecisionRequest[] }

/** People in the same room, of the same type, reacting to the same event with the same options are asked about together. */
function groupRequests(reqs: DecisionRequest[]): Group[] {
  const by = new Map<string, DecisionRequest[]>();
  for (const r of reqs) {
    const k = [r.roomId, r.persona, r.trigger, r.options.map((o) => o.label).join("|")].join("#");
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].map((rs, i) => ({ id: i + 1, reqs: rs }));
}

function describeGroup(g: Group): string {
  const r = g.reqs[0]!;
  const opts = r.options.map((o) => `  ${o.id}. ${o.label}${o.etaS !== undefined ? ` (about ${o.etaS} s)` : ""}${o.notes.length ? ` [${o.notes.join("; ")}]` : ""}`).join("\n");
  const who = g.reqs.length === 1 ? `1 person (${r.name})` : `${g.reqs.length} people (${g.reqs.slice(0, 3).map((x) => x.name).join(", ")}${g.reqs.length > 3 ? ", ..." : ""})`;
  return `Group ${g.id}: ${who}. ${r.personaText}
In: ${r.roomName}, ${r.peopleHere} people in the room in total. Time since the fire started: ${r.timeS} s.
What just happened: ${r.triggerText}
${r.observations.length ? "They notice: " + r.observations.join("; ") + "." : ""}
Options:
${opts}`;
}

export interface AiStats { calls: number; people: number; answered: number; errors: number; lastError: string; ms: number }

/** Asks the model about groups of people. On the device one question runs at a time; the cloud takes several at once. */
export function aiPolicy(where: Exclude<Where, "auto">, onCall?: (st: AiStats) => void): Policy & { stats: AiStats } {
  const BATCH = where === "device" ? 3 : 12; // the cloud model handles long prompts; fewer, larger questions fit the rate limit
  const PARALLEL = where === "device" ? 1 : 3;
  const stats: AiStats = { calls: 0, people: 0, answered: 0, errors: 0, lastError: "", ms: 0 };
  type Reply = { groups: { group: number; split: { option: string; people: number; reason: string }[] }[] };
  async function ask(batch: Group[], out: Decision[]) {
    const people = batch.reduce((n, g) => n + g.reqs.length, 0);
    let a: Answer<Reply>;
    try {
      a = await askJson<Reply>(where, "decide", DECISION_SCHEMA, [`${DECISION_RULES}\n\n${batch.map(describeGroup).join("\n\n")}`]);
    } catch (e) {
      stats.errors++;
      stats.lastError = String(e).slice(0, 200);
      onCall?.(stats);
      return; // these people fall back to the rules, and the run says so
    }
    stats.calls++;
    stats.people += people;
    stats.ms += a.ms;
    for (const g of batch) {
      const ans = a.value.groups.find((x) => x.group === g.id);
      if (!ans) continue;
      const valid = ans.split.filter((x) => g.reqs[0]!.options.some((o) => o.id === x.option) && x.people > 0);
      if (!valid.length) continue;
      // Scale the counts to the group size, then hand options out in order.
      const total = valid.reduce((n, x) => n + x.people, 0);
      let k = 0;
      valid.forEach((x, j) => {
        const n = j === valid.length - 1 ? g.reqs.length - k : Math.round((x.people / total) * g.reqs.length);
        for (let m = 0; m < n && k < g.reqs.length; m++, k++) {
          out.push({ agentId: g.reqs[k]!.agentId, optionId: x.option, reason: x.reason.slice(0, 120), source: a.source === "on_device" ? "on_device" : "cloud" });
          stats.answered++;
        }
      });
    }
    onCall?.(stats);
  }
  return {
    name: where === "device" ? "on_device" : "cloud",
    stats,
    async decide(reqs: DecisionRequest[]): Promise<Decision[]> {
      const out: Decision[] = [];
      const groups = groupRequests(reqs);
      const batches: Group[][] = [];
      for (let i = 0; i < groups.length; i += BATCH) batches.push(groups.slice(i, i + BATCH));
      for (let i = 0; i < batches.length; i += PARALLEL) await Promise.all(batches.slice(i, i + PARALLEL).map((b) => ask(b, out)));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 4. A short reading of one run (on the device) and 5. a written assessment with fixes (cloud).

export async function summariseRun(where: Where, facts: string): Promise<Answer<string>> {
  const t0 = performance.now();
  const m = textModel(where, "summary");
  const res = await call(where, () => m.generateContent(`You are reviewing the result of one fire evacuation simulation for the person responsible for fire safety in a small building.
Write 3 short bullet points (at most 20 words each): what went wrong, where people got stuck, and the single most useful thing to change.
Use only the facts below. Do not invent numbers.

${facts}`), false);
  return { value: res.response.text().trim(), source: sourceOf(res), ms: Math.round(performance.now() - t0) };
}

export interface Assessment { summary: string; findings: string[]; fixes: Fix[] }

export function assessmentSchema(plan: Plan) {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      findings: { type: "array", items: { type: "string" } },
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: { door_id: { type: "string", enum: plan.doors.map((d) => d.id) }, change: { type: "string", enum: ["unlock", "keep_open", "add_exit_sign", "widen"] }, why: { type: "string" } },
          required: ["door_id", "change", "why"],
        },
      },
    },
    required: ["summary", "findings", "fixes"],
  };
}

export async function writeAssessment(plan: Plan, facts: string): Promise<Answer<Assessment>> {
  return askJson<Assessment>("cloud", `assess:${plan.title}:${plan.doors.length}`, assessmentSchema(plan), [
    `You help the person responsible for fire safety in a small building understand a simulated evacuation.
This is a reference simulation, not a fire risk assessment, and you must not say the building is safe or compliant.
Write: a summary of 2-3 sentences; 3-5 findings, each one sentence that points at a room, door or group of people; and 1-3 fixes
that change a door (unlock it, keep it open, add a lit exit sign, or widen it). Each fix says why in one sentence. The app will
re-run the simulation with your fixes to check them, so only suggest fixes you expect to change the outcome.

${describePlan(plan)}

${facts}`,
  ]);
}
