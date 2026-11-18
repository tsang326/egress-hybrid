// Runs the fire model in a worker and stops it when the simulated clock stops moving or a time limit passes,
// so an awkward plan cannot freeze the app.
import type { Result, Scenario } from "../../core/fire";
import { SHUT_DOOR_OPEN_FRACTION, toFireScenario, type DrillScenario } from "../../core/plan/scenario";
import type { Plan } from "../../core/plan/types";
import { defaultWorkerFactory, runFireInWorker, type WorkerLike } from "../fire/fireClient";

export type FireOutcome = { ok: true; result: Result; ms: number } | { ok: false; reason: string; stalled: boolean; ms: number };

export function runFireWithLimit(scenario: Scenario, limitMs: number, onProgress: (fraction: number) => void, stallMs = 6000): Promise<FireOutcome> {
  const t0 = performance.now();
  let worker: WorkerLike | null = null;
  let lastSim = -1;
  let lastMove = performance.now();
  let settle: (o: FireOutcome) => void = () => {};
  const done = new Promise<FireOutcome>((r) => (settle = r));
  const stop = (reason: string, stalled: boolean) => {
    worker?.terminate();
    settle({ ok: false, reason, stalled, ms: Math.round(performance.now() - t0) });
  };
  const factory = () => (worker = defaultWorkerFactory());
  runFireInWorker(scenario, (e) => {
    if (e.simTimeS > lastSim + 1e-3) { lastSim = e.simTimeS; lastMove = performance.now(); }
    onProgress(e.fraction);
  }, factory).then((result) => {
    const ms = Math.round(performance.now() - t0);
    if (result.status === "ok") settle({ ok: true, result, ms });
    else {
      const w = result.warnings[0];
      settle({ ok: false, reason: w ? `${w.code}: ${w.message}` : `fire model status ${result.status}`, stalled: false, ms });
    }
  });
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - t0 > limitMs) stop(`it did not finish within ${Math.round(limitMs / 1000)} s`, false);
    else if (now - lastMove > stallMs) stop(`its clock stopped at ${Math.round(Math.max(0, lastSim))} s of fire time`, true);
  }, 500);
  return done.finally(() => clearInterval(timer));
}

export const LEAKY_SHUT_DOOR = 0.15;

/** The fire for a drill: a normal run, and if the solver stalls, one more with leakier shut doors. */
export async function fireForDrill(plan: Plan, scenario: DrillScenario, onStatus: (text: string) => void, forceFraction?: number): Promise<{ fire: Result | null; note: string | null; shutOpenFraction: number }> {
  const progress = (f: number) => onStatus(`Working out how the fire and smoke spread… ${Math.round(f * 100)} %`);
  let frac = forceFraction ?? SHUT_DOOR_OPEN_FRACTION;
  let fo = await runFireWithLimit(toFireScenario(plan, scenario, frac), 45000, progress);
  let note: string | null = null;
  if (!fo.ok && fo.stalled && forceFraction === undefined) {
    // The two-zone solver can stall when shut doors leak very little; a leakier door usually lets it finish.
    onStatus("The fire model got stuck; trying again with shut doors that leak more…");
    const first = fo.reason;
    frac = LEAKY_SHUT_DOOR;
    fo = await runFireWithLimit(toFireScenario(plan, scenario, frac), 45000, progress);
    if (fo.ok) note = `The fire model got stuck (${first}), so this run treats shut doors as ${Math.round(frac * 100)} % open instead of ${Math.round(SHUT_DOOR_OPEN_FRACTION * 100)} %. Smoke gets through them a little more than it would.`;
  }
  if (!fo.ok) note = `The fire model stopped (${fo.reason}). People move without smoke in this run, so it shows queues only.`;
  return { fire: fo.ok ? fo.result : null, note, shutOpenFraction: frac };
}
