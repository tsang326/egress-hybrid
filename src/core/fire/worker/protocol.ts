// Messages between the main thread and the fire Web Worker (design.md, Worker_Wrapper; Requirements 10.11, 10.12).
// Types only. No logic.
import type { ProgressEvent, Result, Scenario } from "../types";

export type ToWorker = { type: "run"; id: number; scenario: Scenario };

export type FromWorker =
  | { type: "progress"; id: number; event: ProgressEvent }
  | { type: "result"; id: number; result: Result }
  | { type: "error"; id: number; message: string };
