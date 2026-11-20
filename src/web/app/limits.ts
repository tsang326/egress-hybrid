// Limits on cloud AI, set in Firebase Remote Config so they can be changed (or cloud AI paused) without a redeploy.
// The defaults below apply until the first fetch, and if Remote Config cannot be reached.
import { getRemoteConfig, fetchAndActivate, getValue } from "firebase/remote-config";
import { app } from "./firebase";

export const LIMITS = {
  cloudAi: true, // false pauses every call to Gemini in the cloud; Gemini Nano and the rules still work
  maxAiCallsHybrid: 400, // AI questions per run (each question covers a group of people)
  maxAiCallsDevice: 160,
};

export async function loadLimits(): Promise<void> {
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 60_000 : 30 * 60_000;
    rc.settings.fetchTimeoutMillis = 8000;
    rc.defaultConfig = { cloud_ai: true, max_ai_calls_hybrid: 400, max_ai_calls_device: 160 };
    await fetchAndActivate(rc);
    LIMITS.cloudAi = getValue(rc, "cloud_ai").asBoolean();
    const n = (k: string, lo: number, hi: number, d: number) => { const v = getValue(rc, k).asNumber(); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
    LIMITS.maxAiCallsHybrid = n("max_ai_calls_hybrid", 0, 2000, 400);
    LIMITS.maxAiCallsDevice = n("max_ai_calls_device", 0, 2000, 160);
  } catch { /* keep the defaults */ }
}
