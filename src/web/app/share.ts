// Share links: a run is saved to Firestore by an anonymous Firebase user and opened by anyone with the link.
// Only the inputs and the AI's answers are stored; the viewer's browser simulates the fire and the crowd again,
// so a shared run is the same run, not a picture of it. Loaded on demand to keep the first page light.
import { app } from "./firebase";
import type { Plan } from "../../core/plan/types";
import type { DrillScenario } from "../../core/plan/scenario";
import type { RecordedDecision } from "../../core/crowd/recorded";

export interface SharedRun {
  label: string;
  mode: "standard" | "hybrid" | "device";
  plan: Plan;
  scenario: DrillScenario;
  shutOpenFraction: number;
  decisions: RecordedDecision[];
  model: string;
  savedAt: string; // ISO date
  questions: number;
  modelSeconds: number;
  summary?: { text: string; source: string };
  fixedBy?: { changes: string[]; why: string[]; source: string };
}

const MAX_BYTES = 400_000; // matches firestore.rules

async function services() {
  const [{ getAuth, signInAnonymously }, fs] = await Promise.all([import("firebase/auth"), import("firebase/firestore")]);
  return { getAuth, signInAnonymously, ...fs };
}

export async function saveShare(run: SharedRun): Promise<string> {
  const payload = JSON.stringify(run);
  if (payload.length >= MAX_BYTES) throw new Error("this run is too large to share");
  const { getAuth, signInAnonymously, getFirestore, collection, addDoc, serverTimestamp } = await services();
  const auth = getAuth(app);
  const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
  const ref = await addDoc(collection(getFirestore(app), "shares"), { owner: user.uid, createdAt: serverTimestamp(), v: 1, payload });
  return ref.id;
}

export async function loadShare(id: string): Promise<SharedRun | null> {
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
  const { getFirestore, doc, getDoc } = await services();
  const snap = await getDoc(doc(getFirestore(app), "shares", id));
  if (!snap.exists()) return null;
  const d = snap.data() as { v?: number; payload?: string };
  if (d.v !== 1 || typeof d.payload !== "string") return null;
  return JSON.parse(d.payload) as SharedRun;
}

export const shareUrl = (id: string) => `${location.origin}${import.meta.env.BASE_URL}?s=${id}`;
