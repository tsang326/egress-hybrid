import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runFire } from "../src/core/fire";
import { SAMPLES } from "../src/core/plan/samples";
import { toFireScenario } from "../src/core/plan/scenario";
import { runCrowd } from "../src/core/crowd/sim";
import { standardPolicy } from "../src/core/crowd/standardPolicy";
import { recordingPolicy, replayPolicy, type Recording } from "../src/core/crowd/recorded";
import type { CrowdResult } from "../src/core/crowd/types";

const sig = (r: CrowdResult) => r.agents.map((a) => `${a.outcome}:${a.timeS}:${a.decisions.map((d) => d.chosen).join("/")}`).join(",");
const house = SAMPLES.find((s) => s.id === "house")!;

test("a recorded run plays back to the same result", async () => {
  const fire = runFire(toFireScenario(house.plan, house.scenario));
  // The sim skips the policy when it is the fallback itself, so give the rules another name, as an AI policy would have.
  const asAi = { name: "test_ai", decide: async (reqs: Parameters<typeof standardPolicy.decide>[0]) => (await standardPolicy.decide(reqs)).map((d) => ({ ...d, source: "on_device" as const })) };
  const rec = recordingPolicy(asAi);
  const live = await runCrowd(house.plan, house.scenario, fire, rec, { fallback: standardPolicy });
  const recording: Recording = { schemaVersion: 1, planTitle: house.plan.title, scenarioSeed: house.scenario.seed, shutOpenFraction: 0.05, model: "rules", recordedAt: "2026-11-18", modelSeconds: 0, questions: 0, decisions: rec.log };
  const replay = replayPolicy(recording);
  const again = await runCrowd(house.plan, house.scenario, fire, replay, { fallback: standardPolicy });
  expect(rec.log.length).toBeGreaterThan(0);
  expect(replay.misses).toBe(0);
  expect(sig(again)).toBe(sig(live));
}, 120000);

test.each(["cafe", "office", "house"])("the shipped Gemini Nano recording for %s still matches the sample", async (id) => {
  const smp = SAMPLES.find((s) => s.id === id)!;
  const rec = JSON.parse(readFileSync(`public/recorded/${id}.json`, "utf8")) as Recording;
  expect(rec.planTitle).toBe(smp.plan.title);
  expect(rec.scenarioSeed).toBe(smp.scenario.seed);
  const fire = runFire(toFireScenario(smp.plan, smp.scenario, rec.shutOpenFraction));
  const replay = replayPolicy(rec);
  const r = await runCrowd(smp.plan, smp.scenario, fire, replay, { fallback: standardPolicy });
  // Questions the model left unanswered in the live run fall back to the rules again here.
  expect(r.decisionsBySource).toEqual(rec.bySource);
}, 120000);
