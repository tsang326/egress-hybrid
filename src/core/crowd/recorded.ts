// Recording a run's AI decisions and playing them back. The crowd model is deterministic for a given plan, scenario
// and fire result, so feeding back the same answers reproduces the same run. The app uses this to show runs that
// Gemini Nano made on a computer that has it, labelled as recorded, to visitors whose browser has no on-device model.
import type { Decision, DecisionRequest, DecisionSource, Policy } from "./types";

export interface RecordedDecision { a: number; t: number; tr: string; o: string; r: string; s: DecisionSource }

export interface Recording {
  schemaVersion: 1;
  planTitle: string;
  scenarioSeed: number;
  shutOpenFraction: number;
  model: string;
  recordedAt: string; // ISO date
  modelSeconds: number;
  questions: number;
  decisions: RecordedDecision[];
  /** Decision tally of the run as recorded, so a replay can be checked against it. */
  bySource?: Record<DecisionSource, number>;
}

const key = (agentId: number, timeS: number, trigger: string) => `${agentId}@${timeS}@${trigger}`;

/** Wraps a policy and keeps every answer it gives. */
export function recordingPolicy(inner: Policy): Policy & { log: RecordedDecision[] } {
  const log: RecordedDecision[] = [];
  return {
    name: inner.name,
    log,
    async decide(reqs: DecisionRequest[]): Promise<Decision[]> {
      const out = await inner.decide(reqs);
      for (const d of out) {
        const r = reqs.find((x) => x.agentId === d.agentId);
        if (r) log.push({ a: d.agentId, t: r.timeS, tr: r.trigger, o: d.optionId, r: d.reason, s: d.source });
      }
      return out;
    },
  };
}

/** Gives back recorded answers. Requests with no recorded answer are left to the fallback rules, as in a live run. */
export function replayPolicy(rec: Recording): Policy & { misses: number } {
  const byKey = new Map(rec.decisions.map((d) => [key(d.a, d.t, d.tr), d]));
  const p = {
    name: rec.decisions[0]?.s === "cloud" ? "cloud" : "on_device",
    misses: 0,
    async decide(reqs: DecisionRequest[]): Promise<Decision[]> {
      const out: Decision[] = [];
      for (const r of reqs) {
        const d = byKey.get(key(r.agentId, r.timeS, r.trigger));
        if (d && r.options.some((o) => o.id === d.o)) out.push({ agentId: r.agentId, optionId: d.o, reason: d.r, source: d.s });
        else p.misses++;
      }
      return out;
    },
  };
  return p;
}
