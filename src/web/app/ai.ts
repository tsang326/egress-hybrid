// What the app asks the models to do. Each task names where it runs and why.
import type { Decision, DecisionRequest, Policy } from "../../core/crowd/types";
import { FIRE_ITEMS } from "../../core/plan/fireItems";
import type { DrillScenario, PersonaKind } from "../../core/plan/scenario";
import { OUTSIDE, type Plan } from "../../core/plan/types";
import type { Fix } from "../../core/report";
import { CLOUD_MODEL, CLOUD_VISION_MODEL, jsonModel, textModel, type Where } from "./firebase";

export type Source = "on_device" | "cloud";
export interface Answer<T> { value: T; source: Source; ms: number; model?: string | undefined } // model: the cloud model that answered
/** Gemma is Google's open model; the app names it whenever it answered instead of Gemini. */
export const GEMMA = "gemma-4-26b-a4b-it";
export const isGemma = (model?: string): boolean => !!model && model.startsWith("gemma");

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

// Free-tier quotas are counted per model. When one cloud model's quota is used up, questions move to the other
// cloud model; when both are used up, cloud questions stop for a while (longer each time) and the people who would
// have asked them follow the rules, so a run always finishes.
// On the free tier (AI Studio, Nov 2026): 3.5 Flash-Lite and 3.1 Flash-Lite each allow 15 requests a minute and
// 500 a day; Gemma 4 26B A4B 30 a minute and 14,400 a day (but 16K tokens a minute); 3.5 Flash 5 a minute and 20 a
// day, so it is the last resort.
const CLOUD_MODELS = [CLOUD_MODEL, "gemini-3.1-flash-lite", GEMMA, CLOUD_VISION_MODEL];
const quotaOutUntil = new Map<string, number>();
const quotaStrikes = new Map<string, number>();
const hasQuota = (model: string) => (quotaOutUntil.get(model) ?? 0) <= Date.now();
function quotaUsedUp(model: string, daily: boolean): void {
  const strikes = (quotaStrikes.get(model) ?? 0) + 1;
  quotaStrikes.set(model, strikes);
  quotaOutUntil.set(model, Date.now() + (daily ? 24 * 3600e3 : Math.min(24 * 3600e3, 5 * 60e3 * 2 ** (strikes - 1))));
}
/** True while every cloud model has hit its quota. */
export const cloudQuotaOut = (): boolean => !CLOUD_MODELS.some(hasQuota);
export const QUOTA_OUT = "The free cloud models (Gemini, then Gemma) are out of quota or busy right now. Rules, Gemini Nano (on a computer that has it) and the recorded Gemini Nano runs still work.";

/** Calls a model with the rate limit, retries and quota fallback above. Device calls go straight through. */
async function call<R>(where: Where, primary: string, run: (model: string) => Promise<R>, canFallBack: boolean): Promise<R> {
  if (where === "device") return run(primary);
  const order = [primary, ...CLOUD_MODELS.filter((m) => m !== primary)];
  let model = order.find(hasQuota);
  if (!model) throw new Error(QUOTA_OUT);
  let errors = 0, quotaHits = 0;
  for (;;) {
    await cloudSlot();
    try {
      return await run(model);
    } catch (e) {
      const m = String(e);
      // The API also answers 429 when a model is overloaded; that is a busy model, not a used-up quota.
      if (/\b429\b|quota|exhausted/i.test(m) && !/overloaded|high demand/i.test(m)) {
        const daily = /per ?day|daily/i.test(m);
        // One 20 s wait covers a per-minute limit (two for Gemma, whose token limit per minute is small); after
        // that, a 429 means this model's quota is used up.
        if (!daily && ++quotaHits < (isGemma(model) ? 3 : 2)) { await sleep(20000); continue; }
        quotaUsedUp(model, daily);
        quotaHits = 0;
        model = order.find(hasQuota);
        if (!model) throw new Error(QUOTA_OUT);
        continue;
      }
      const busy = /\b(429|500|503)\b|high demand|overloaded|abort|timeout/i.test(m);
      // A busy fallback model is set aside for 2 minutes and the next one is tried, so a run never waits long on it.
      if (busy && model !== primary) {
        quotaOutUntil.set(model, Date.now() + 2 * 60e3);
        model = order.find(hasQuota);
        if (!model) throw new Error(QUOTA_OUT);
        continue;
      }
      if (++errors > 2) throw e;
      if (busy) {
        if (canFallBack && model !== CLOUD_MODEL && hasQuota(CLOUD_MODEL)) model = CLOUD_MODEL; // a busy larger model falls back to the lighter one
        await sleep(/overloaded|high demand/i.test(m) ? 5000 : 1500);
        continue;
      }
      throw e;
    }
  }
}

async function askJson<T>(where: Where, key: string, schema: Record<string, unknown>, parts: (string | { inlineData: { mimeType: string; data: string } })[], opts: { image?: boolean; cloudModel?: string; timeoutMs?: number } = {}): Promise<Answer<T>> {
  const t0 = performance.now();
  const content = parts.map((p) => (typeof p === "string" ? { type: "text" as const, text: p } : { type: "inlineData" as const, ...p }));
  const primary = opts.cloudModel ?? CLOUD_MODEL;
  let used = primary;
  const res = await call(where, primary, (model) => (used = model, jsonModel(where, key + model, schema, { ...opts, cloudModel: model, ...(isGemma(model) ? { timeoutMs: 120000 } : {}) }).generateContent(content)), primary !== CLOUD_MODEL);
  const text = res.response.text().trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const source = sourceOf(res);
  return { value: JSON.parse(text) as T, source, ms: Math.round(performance.now() - t0), model: source === "cloud" ? used : undefined };
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
written about the people with "they" (never "he" or "she": the group may be several people, and answers for one person
can come from different calls).`;

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

export interface AiStats {
  calls: number; people: number; answered: number; errors: number; lastError: string; ms: number;
  onDevice: number; inCloud: number; handedToCloud: number; // answers by where they ran; groups Nano could not finish
  quotaOut?: boolean; // the cloud quota ran out during the run, so the cloud's share followed the rules
  gemma?: number; // cloud choices Gemma made because Gemini's quota was used up
}

export type PolicyMode = "device" | "cloud" | "hybrid";

/** How long Gemini Nano gets at each decision moment before the rest goes to the cloud (hybrid mode). */
const DEVICE_BUDGET_S = 8;

/**
 * People's choices, asked of the models in groups.
 * - device: Gemini Nano answers everything, one question at a time. Nothing leaves the computer.
 * - cloud: Gemini in the cloud answers everything, several questions at once.
 * - hybrid: at each decision moment Nano takes as many groups as it can answer in about DEVICE_BUDGET_S seconds,
 *   judged from how fast it has been so far; the cloud takes the rest at the same time, and anything Nano fails on.
 */
export function aiPolicy(mode: PolicyMode, onCall?: (st: AiStats) => void): Policy & { stats: AiStats } {
  const DEVICE_BATCH = 3, CLOUD_BATCH = 12, CLOUD_PARALLEL = 3;
  const stats: AiStats = { calls: 0, people: 0, answered: 0, errors: 0, lastError: "", ms: 0, onDevice: 0, inCloud: 0, handedToCloud: 0 };
  let deviceSPerGroup = 2.5; // first guess, then a running average of what Nano actually takes
  let deviceFailures = 0;
  type Reply = { groups: { group: number; split: { option: string; people: number; reason: string }[] }[] };

  /** Asks one batch; returns the groups it could not answer. */
  async function ask(where: "device" | "cloud", batch: Group[], out: Decision[]): Promise<Group[]> {
    const people = batch.reduce((n, g) => n + g.reqs.length, 0);
    if (where === "cloud" && cloudQuotaOut()) { stats.quotaOut = true; onCall?.(stats); return batch; }
    let a: Answer<Reply>;
    try {
      a = await askJson<Reply>(where, "decide", DECISION_SCHEMA, [`${DECISION_RULES}\n\n${batch.map(describeGroup).join("\n\n")}`]);
    } catch (e) {
      stats.errors++;
      stats.lastError = String(e).slice(0, 200);
      if (cloudQuotaOut()) stats.quotaOut = true;
      if (where === "device") deviceFailures++;
      onCall?.(stats);
      return batch;
    }
    stats.calls++;
    stats.people += people;
    stats.ms += a.ms;
    if (a.source === "on_device") deviceSPerGroup = 0.6 * deviceSPerGroup + 0.4 * (a.ms / 1000 / batch.length);
    const missed: Group[] = [];
    for (const g of batch) {
      const ans = a.value.groups.find((x) => x.group === g.id);
      const valid = ans ? ans.split.filter((x) => g.reqs[0]!.options.some((o) => o.id === x.option) && x.people > 0) : [];
      if (!valid.length) { missed.push(g); continue; }
      // Scale the counts to the group size, then hand options out in order.
      const total = valid.reduce((n, x) => n + x.people, 0);
      let k = 0;
      valid.forEach((x, j) => {
        const n = j === valid.length - 1 ? g.reqs.length - k : Math.round((x.people / total) * g.reqs.length);
        for (let m = 0; m < n && k < g.reqs.length; m++, k++) {
          out.push({ agentId: g.reqs[k]!.agentId, optionId: x.option, reason: x.reason.slice(0, 120), source: a.source === "on_device" ? "on_device" : "cloud" });
          stats.answered++;
          if (a.source === "on_device") stats.onDevice++; else stats.inCloud++;
          if (isGemma(a.model)) stats.gemma = (stats.gemma ?? 0) + 1;
        }
      });
    }
    onCall?.(stats);
    return missed;
  }

  async function onDevice(groups: Group[], out: Decision[]): Promise<Group[]> {
    const left: Group[] = [];
    for (let i = 0; i < groups.length; i += DEVICE_BATCH) {
      // After two failures in a row Nano is skipped for the rest of the run in hybrid mode.
      if (mode === "hybrid" && deviceFailures >= 2) { left.push(...groups.slice(i)); break; }
      const missed = await ask("device", groups.slice(i, i + DEVICE_BATCH), out);
      if (missed.length < Math.min(DEVICE_BATCH, groups.length - i)) deviceFailures = 0;
      left.push(...missed);
    }
    return left;
  }

  async function inCloud(groups: Group[], out: Decision[]): Promise<void> {
    const batches: Group[][] = [];
    for (let i = 0; i < groups.length; i += CLOUD_BATCH) batches.push(groups.slice(i, i + CLOUD_BATCH));
    for (let i = 0; i < batches.length; i += CLOUD_PARALLEL) await Promise.all(batches.slice(i, i + CLOUD_PARALLEL).map((b) => ask("cloud", b, out)));
  }

  return {
    name: mode === "device" ? "on_device" : mode === "cloud" ? "cloud" : "hybrid",
    stats,
    async decide(reqs: DecisionRequest[]): Promise<Decision[]> {
      const out: Decision[] = [];
      const groups = groupRequests(reqs);
      if (mode === "device") { await onDevice(groups, out); return out; }
      if (mode === "cloud") { await inCloud(groups, out); return out; }
      // With the cloud quota used up, Nano takes every group it can.
      const n = deviceFailures >= 2 ? 0 : cloudQuotaOut() ? groups.length : Math.max(1, Math.floor(DEVICE_BUDGET_S / deviceSPerGroup));
      const mine = groups.slice(0, n), rest = groups.slice(n);
      stats.handedToCloud += rest.length;
      const [missed] = await Promise.all([onDevice(mine, out), inCloud(rest, out)]);
      if (missed.length) { stats.handedToCloud += missed.length; await inCloud(missed, out); }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 4. A short reading of one run (on the device) and 5. a written assessment with fixes (cloud).

export async function summariseRun(where: Where, facts: string): Promise<Answer<string>> {
  const t0 = performance.now();
  let used = CLOUD_MODEL;
  const res = await call(where, CLOUD_MODEL, (model) => (used = model, textModel(where, "summary" + model, model)).generateContent(`You are reviewing the result of one fire evacuation simulation for the person responsible for fire safety in a small building.
Write 3 short bullet points (at most 20 words each): what went wrong, where people got stuck, and the single most useful thing to change.
Use only the facts below. Do not invent numbers.

${facts}`), false);
  const source = sourceOf(res);
  return { value: res.response.text().trim(), source, ms: Math.round(performance.now() - t0), model: source === "cloud" ? used : undefined };
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
          properties: { door_id: { type: "string", enum: plan.doors.map((d) => d.id) }, change: { type: "string", enum: ["unlock", "keep_open", "keep_closed", "add_exit_sign", "widen"] }, why: { type: "string" } },
          required: ["door_id", "change", "why"],
        },
      },
    },
    required: ["summary", "findings", "fixes"],
  };
}

export async function writeAssessment(where: Where, plan: Plan, facts: string): Promise<Answer<Assessment>> {
  return askJson<Assessment>(where, `assess:${plan.title}:${plan.doors.length}`, assessmentSchema(plan), [
    `You help the person responsible for fire safety in a small building understand a simulated evacuation.
This is a reference simulation, not a fire risk assessment, and you must not say the building is safe or compliant.
Write: a summary of 2-3 sentences; 3-5 findings, each one sentence that points at a room, door or group of people; and 1-3 fixes
that change a door: unlock it, keep it open, fit a door closer so it stays shut (keeps smoke out of escape routes), add a
lit exit sign, or widen it. Each fix says why in one sentence. The app will
re-run the simulation with your fixes to check them, so only suggest fixes you expect to change the outcome.

${describePlan(plan)}

${facts}`,
  ]);
}
