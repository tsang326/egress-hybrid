import { parseScenario, readPlanPhoto, aiPolicy, summariseRun } from "../src/web/app/ai";
import { CAFE, CAFE_LUNCH } from "../src/core/plan/samples";
import { runCrowd } from "../src/core/crowd/sim";
import { standardPolicy } from "../src/core/crowd/standardPolicy";
const out: Record<string, unknown> = {};
(window as any).__out = out;
async function step(name: string, f: () => Promise<unknown>) {
  try { out[name] = await f(); } catch (e) { out[name] = { error: String(e), stack: (e as Error).stack?.slice(0, 400) }; }
}
(window as any).run = async (which: string) => {
  const text = "Fryer fire in the kitchen during lunch, 40 diners and 3 cooks, the back door is blocked by deliveries.";
  if (which.includes("scen-cloud")) await step("scen-cloud", () => parseScenario("cloud", CAFE, text));
  if (which.includes("scen-device")) await step("scen-device", () => parseScenario("device", CAFE, text));
  if (which.includes("photo")) await step("photo-cloud", async () => {
    const b = await (await fetch("/dev/cafe-plan.png")).blob();
    const base64 = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]!); fr.readAsDataURL(b); });
    return readPlanPhoto("cloud", { mimeType: "image/png", base64 });
  });
  if (which.includes("decide")) await step("decide-device", async () => {
    const calls: unknown[] = [];
    const r = await runCrowd(CAFE, { ...CAFE_LUNCH, lockedDoors: ["D1"] }, null, aiPolicy("device", (n, s, ms) => calls.push({ n, s, ms })), { fallback: standardPolicy, maxAiCalls: 150 });
    return { calls, bySource: r.decisionsBySource, t: r.endTimeS, out: r.agents.filter(a=>a.outcome==="out").length, sample: r.agents.filter((_,i)=>i%7===0).map((a) => a.decisions.map((d) => `${d.source} ${d.chosen} — ${d.reason}`)) };
  });
  if (which.includes("summary")) await step("summary-device", () => summariseRun("device", "People: 53. Got out: 50. Overcome: 3 in the WC. Front door D1 locked. Doors used: D2 kitchen 35 people, queue 22."));
  return out;
};
document.getElementById("o")!.textContent = "ready";
