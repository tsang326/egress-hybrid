// Firebase setup: App Check protects the Gemini API; AI Logic routes each request on-device or to the cloud.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel } from "firebase/ai";

const firebaseConfig = {
  apiKey: "AIzaSyDeytaczxeARhVhT_pVySnGU6TW6j0INQA",
  authDomain: "egress-hybrid-mntd.firebaseapp.com",
  projectId: "egress-hybrid-mntd",
  storageBucket: "egress-hybrid-mntd.firebasestorage.app",
  messagingSenderId: "906698064822",
  appId: "1:906698064822:web:c9512a67d85d7ff332f717",
};

// The debug token lives in .env.development.local, which Vite reads only in dev; a production build never sees it.
const debugToken = import.meta.env.DEV ? (import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined) : undefined;
if (debugToken) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
const recaptchaKey = (import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY as string | undefined) ?? "debug-only";

export const app = initializeApp(firebaseConfig);
export const appCheck = initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaKey), isTokenAutoRefreshEnabled: true });
export const ai = getAI(app, { backend: new GoogleAIBackend() });

export type Where = "device" | "cloud" | "auto";
export const CLOUD_MODEL = "gemini-3.5-flash-lite";
export const CLOUD_VISION_MODEL = "gemini-3.5-flash";

const MODE: Record<Where, (typeof InferenceMode)[keyof typeof InferenceMode]> = {
  device: InferenceMode.ONLY_ON_DEVICE,
  cloud: InferenceMode.ONLY_IN_CLOUD,
  auto: InferenceMode.PREFER_ON_DEVICE,
};

const cache = new Map<string, GenerativeModel>();

/** A model that answers with JSON matching `schema`, on the device, in the cloud, or on the device when it can. */
export function jsonModel(where: Where, key: string, schema: Record<string, unknown>, opts: { image?: boolean; cloudModel?: string; timeoutMs?: number } = {}): GenerativeModel {
  const k = `${where}:${key}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const m = getGenerativeModel(ai, {
    mode: MODE[where],
    inCloudParams: {
      model: opts.cloudModel ?? CLOUD_MODEL,
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.4 },
    },
    onDeviceParams: {
      createOptions: { expectedInputs: opts.image ? [{ type: "text" }, { type: "image" }] : [{ type: "text" }] },
      promptOptions: { responseConstraint: schema },
    },
  }, { timeout: opts.timeoutMs ?? 45000 });
  cache.set(k, m);
  return m;
}

/** A plain-text model for summaries and reports. */
export function textModel(where: Where, key: string, cloudModel = CLOUD_MODEL): GenerativeModel {
  const k = `text:${where}:${key}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const m = getGenerativeModel(ai, {
    mode: MODE[where],
    inCloudParams: { model: cloudModel, generationConfig: { temperature: 0.5 } },
    onDeviceParams: { createOptions: { expectedInputs: [{ type: "text" }] } },
  }, { timeout: 45000 });
  cache.set(k, m);
  return m;
}

export type DeviceStatus = "checking" | "available" | "downloadable" | "downloading" | "unavailable" | "no-api";

export async function deviceStatus(): Promise<DeviceStatus> {
  const LM = (self as unknown as { LanguageModel?: { availability(o?: unknown): Promise<string> } }).LanguageModel;
  if (!LM) return "no-api";
  try {
    const s = await LM.availability({ expectedInputs: [{ type: "text" }] });
    return (["available", "downloadable", "downloading", "unavailable"].includes(s) ? s : "unavailable") as DeviceStatus;
  } catch {
    return "unavailable";
  }
}

/** Starts the on-device model download. Must be called from a click. */
export async function prepareDevice(onProgress: (p: number) => void): Promise<void> {
  const m = textModel("device", "init");
  await m.initializeDeviceModel?.(onProgress);
}
