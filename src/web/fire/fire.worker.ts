// Web Worker entry: runs the fire model off the main thread (design.md, Worker_Wrapper).
import type { ToWorker } from "../../core/fire/worker/protocol";
import { handleMessage } from "./workerHandler";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  handleMessage(e.data, (message, transfer) => scope.postMessage(message, transfer), () => performance.now());
};
