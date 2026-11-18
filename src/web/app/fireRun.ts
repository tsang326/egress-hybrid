// Runs the fire model in a worker and gives up after a time limit, so an odd plan cannot freeze the app.
import type { Result, Scenario } from "../../core/fire";
import { defaultWorkerFactory, runFireInWorker, type WorkerLike } from "../fire/fireClient";

export type FireOutcome = { ok: true; result: Result; ms: number } | { ok: false; reason: string; ms: number };

export function runFireWithLimit(scenario: Scenario, limitMs: number, onProgress: (fraction: number) => void): Promise<FireOutcome> {
  const t0 = performance.now();
  let worker: WorkerLike | null = null;
  const factory = () => (worker = defaultWorkerFactory());
  const run = runFireInWorker(scenario, (e) => onProgress(e.fraction), factory).then((result): FireOutcome => {
    const ms = Math.round(performance.now() - t0);
    if (result.status === "ok") return { ok: true, result, ms };
    const w = result.warnings[0];
    return { ok: false, reason: w ? `${w.code}: ${w.message}` : `fire model status ${result.status}`, ms };
  });
  const limit = new Promise<FireOutcome>((resolve) =>
    setTimeout(() => {
      worker?.terminate();
      resolve({ ok: false, reason: `the fire model did not finish within ${Math.round(limitMs / 1000)} s`, ms: limitMs });
    }, limitMs),
  );
  return Promise.race([run, limit]);
}
