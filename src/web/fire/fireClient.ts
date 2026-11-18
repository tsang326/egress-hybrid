// Main-thread wrapper around the fire worker (design.md, Worker_Wrapper; Requirements 10.5, 10.11, 10.12).
import type { ProgressEvent, Result, Scenario } from "../../core/fire";
import { emptyResult } from "../../core/fire/result";
import { workerError } from "../../core/fire/validate/warnings";
import type { FromWorker, ToWorker } from "../../core/fire/worker/protocol";

/** The part of `Worker` the client uses, so tests can inject a fake. */
export interface WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  postMessage(message: ToWorker): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

export const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("./fire.worker.ts", import.meta.url), { type: "module" });

let nextId = 1;

/**
 * Runs the scenario in a new worker. Resolves with the Result. On a worker `error`, a `messageerror` or an `error`
 * message, resolves with a "failed" Result carrying a WORKER_ERROR warning and terminates the worker (Requirement 10.12).
 */
export function runFireInWorker(
  scenario: Scenario,
  onProgress: (e: ProgressEvent) => void = () => {},
  factory: WorkerFactory = defaultWorkerFactory,
): Promise<Result> {
  return new Promise<Result>((resolve) => {
    const id = nextId++;
    let worker: WorkerLike;
    try {
      worker = factory();
    } catch (e) {
      resolve(emptyResult("failed", [workerError(e instanceof Error ? e.message : String(e))], []));
      return;
    }
    let done = false;
    const finish = (result: Result): void => {
      if (done) return;
      done = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      resolve(result);
    };
    const fail = (detail: string): void => finish(emptyResult("failed", [workerError(detail)], []));

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === "progress") onProgress(m.event);
      else if (m.type === "result") finish(m.result);
      else fail(m.message);
    };
    worker.onerror = (e) => fail(e.message || "unhandled error in worker");
    worker.onmessageerror = () => fail("the worker sent a message that could not be read");
    worker.postMessage({ type: "run", id, scenario });
  });
}
