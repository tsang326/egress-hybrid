// Worker-side logic, separate from the `self` wiring so it can run under a fake or a worker_threads port in tests.
// It calls the same runFire as the Node tests, with no environment branches (Requirement 11.7).
import { runFire, type Result } from "../../core/fire";
import type { FromWorker, ToWorker } from "../../core/fire/worker/protocol";

export type Post = (message: FromWorker, transfer: ArrayBuffer[]) => void;

/** Every distinct ArrayBuffer behind a typed array in the Result (Requirement 10.11: transferred, not copied). */
export function collectTransferables(result: Result): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (a: Float64Array | undefined): void => {
    if (a !== undefined && a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  };
  const addLayer = (l: Result["compartments"][number]["upper"]): void => {
    add(l.o2);
    add(l.co2);
    add(l.co);
    add(l.h2o);
    add(l.soot);
    add(l.opticalDensityPerM);
    add(l.visibilityM);
  };
  add(result.timesS);
  add(result.stats.stepSizesS);
  for (const c of result.compartments) {
    add(c.upperTempK);
    add(c.lowerTempK);
    add(c.interfaceHeightM);
    add(c.pressurePa);
    add(c.upperVolumeM3);
    addLayer(c.upper);
    addLayer(c.lower);
    for (const b of c.burnedHrrW) add(b.values);
  }
  for (const v of result.vents) {
    add(v.openFraction);
    for (const e of v.ends) {
      add(e.upperInKgS);
      add(e.upperOutKgS);
      add(e.lowerInKgS);
      add(e.lowerOutKgS);
    }
  }
  return [...buffers];
}

/** Handles one message. Each progress event is posted at the moment runFire emits it (Requirement 10.11). */
export function handleMessage(msg: ToWorker, post: Post, now: () => number): void {
  if (msg.type !== "run") return;
  const { id } = msg;
  try {
    const result = runFire(msg.scenario, { onProgress: (event) => post({ type: "progress", id, event }, []), now });
    post({ type: "result", id, result }, collectTransferables(result));
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) }, []);
  }
}
