import "./app/style.css";
import { HazardField } from "../core/crowd/hazard";
import { PERSONAS } from "../core/crowd/personas";
import { runCrowd } from "../core/crowd/sim";
import { recordingPolicy, replayPolicy, type RecordedDecision, type Recording } from "../core/crowd/recorded";
import { standardPolicy } from "../core/crowd/standardPolicy";
import type { CrowdResult, Policy } from "../core/crowd/types";
import type { Result } from "../core/fire";
import { planFromRough } from "../core/plan/layout";
import { FIRE_ITEMS, fireItem } from "../core/plan/fireItems";
import { SAMPLES } from "../core/plan/samples";
import { type DrillScenario, type PersonaKind } from "../core/plan/scenario";
import { OUTSIDE, checkPlan, type Plan } from "../core/plan/types";
import { applyFixes, factsText, runFacts, type Fix } from "../core/report";
import { aiPolicy, type AiStats, parseScenario, readPlanPhoto, summariseRun, toDrill, writeAssessment, type Source } from "./app/ai";
import { CLOUD_MODEL, deviceStatus, prepareDevice, type DeviceStatus, type Where } from "./app/firebase";
import { LIMITS, loadLimits } from "./app/limits";
import { loadShare, saveShare, shareUrl, type SharedRun } from "./app/share";
import { fireForDrill } from "./app/fireRun";
import { PlanRenderer } from "./app/render";

type Mode = "standard" | "hybrid" | "device";

interface Run {
  label: string;
  plan: Plan;
  scenario: DrillScenario;
  fire: Result | null;
  fireNote: string | null;
  hazard: HazardField | null;
  crowd: CrowdResult;
  mode: Mode;
  ai: AiStats | null;
  shutOpenFraction: number;
  log: RecordedDecision[] | null; // the AI's answers, so a run can be saved and played back
  recorded: { model: string; recordedAt: string; questions: number; modelSeconds: number } | null;
  summary?: { text: string; source: Source };
  compareTo?: number; // the run this one is compared with (the run a fix was tested against)
  fixedBy?: { changes: string[]; why: string[]; source: Source };
}

const S = {
  sample: 0,
  plan: structuredClone(SAMPLES[0]!.plan) as Plan,
  scenario: structuredClone(SAMPLES[0]!.scenario) as DrillScenario,
  mode: "standard" as Mode,
  device: "checking" as DeviceStatus,
  runs: [] as Run[],
  shown: 0,
  timeS: 0,
  playing: false,
  speed: 8,
  selected: null as number | null,
  busy: "" as string,
  notes: [] as string[],
  fixes: null as { summary: string; findings: string[]; fixes: Fix[]; source: Source } | null,
  fromSample: true,
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const roomName = (p: Plan, id: string) => (id === OUTSIDE ? "outside" : p.rooms.find((r) => r.id === id)?.name ?? id);
const doorLabel = (p: Plan, id: string) => {
  const d = p.doors.find((x) => x.id === id);
  return d ? `${d.id}: ${roomName(p, d.a)} to ${roomName(p, d.b)}` : id;
};
const fmtS = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
const SOURCE_LABEL: Record<string, string> = { standard: "Rules", on_device: "On this device", cloud: "Cloud", fallback: "Rules (no AI answer)" };

document.getElementById("app")!.innerHTML = `
<header class="top">
  <div class="brand">
    <svg class="mark" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" fill="currentColor"/><circle cx="16" cy="9" r="3.2" fill="#fff"/><path d="M15 13 L11 23 L17 31 M11 23 L5 29 M14 15 L22 18 M24 23 H35 M31 19 L35 23 L31 27" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <div><h1>Egress</h1><p>Run a fire drill on your building before you run it for real.</p></div>
  </div>
  <div class="device" id="device"></div>
</header>
<main class="layout">
  <section class="setup" aria-label="Drill set-up">
   <div class="setup-body">
    <div class="block">
      <h2>Building</h2>
      <div class="row">
        <select id="sample" aria-label="Sample building">${SAMPLES.map((s, i) => `<option value="${i}">${esc(s.plan.title)}</option>`).join("")}</select>
        <label class="btn ghost file">Read a photo of a plan<input type="file" id="photo" accept="image/*" hidden></label>
      </div>
      <p class="hint" id="planhint"></p>
    </div>
    <div class="block">
      <h2>What happens</h2>
      <textarea id="story" rows="3" placeholder="For example: chip pan fire in the kitchen at lunch, 40 diners and 3 cooks, the back door is blocked by deliveries."></textarea>
      <div class="row"><button class="btn ghost" id="parse">Fill in from this</button><span class="src" id="parsesrc"></span></div>
      <div id="scenario"></div>
    </div>
   </div>
   <div class="setup-foot">
      <h2 id="modes-h">How people decide</h2>
      <div class="modes" role="radiogroup" aria-labelledby="modes-h" id="modes">
        <label><input type="radio" name="mode" value="standard" checked><span>Rules</span></label>
        <label><input type="radio" name="mode" value="hybrid"><span>Gemini, hybrid</span></label>
        <label><input type="radio" name="mode" value="device"><span>On this computer only</span></label>
      </div>
      <p class="hint" id="modehint"></p>
      <button class="btn primary" id="run">Run the drill</button>
      <p class="hint" id="busy" aria-live="polite"></p><p class="hint warn" id="err" role="alert"></p>
   </div>
  </section>
  <section class="stage" aria-label="Plan">
    <div class="runs" id="runs"></div>
    <div class="canvaswrap"><canvas id="plan" aria-label="Plan of the building with people and smoke"></canvas></div>
    <div class="timeline">
      <button class="btn icon" id="play" aria-label="Play">▶</button>
      <input type="range" id="time" min="0" max="600" step="1" value="0" aria-label="Time">
      <output id="clock">0 s</output>
      <select id="speed" aria-label="Playback speed"><option value="4">4×</option><option value="8" selected>8×</option><option value="20">20×</option></select>
    </div>
    <ul class="legend">
      <li><i class="d premove"></i>Not moving yet</li><li><i class="d moving"></i>Moving</li><li><i class="d queue"></i>Waiting at a door</li>
      <li><i class="d guide"></i>Staff helping</li><li><i class="d shelter"></i>Sheltering</li><li><i class="d down"></i>Overcome</li><li><i class="sw smoke"></i>Smoke at head height</li>
    </ul>
  </section>
  <section class="results" aria-label="Results" id="results"></section>
</main>
<footer class="foot">Fire and smoke: two-zone model after NIST CFAST. Tenability: ISO 13571 heat and CO doses. A drill simulation is a way to see problems, not a fire risk assessment.</footer>
`;

const renderer = new PlanRenderer($<HTMLCanvasElement>("#plan"));
const current = () => S.runs[S.shown];

function draw() {
  const r = current();
  renderer.draw({
    plan: r?.plan ?? S.plan,
    scenario: r?.scenario ?? S.scenario,
    hazard: r?.hazard ?? null,
    crowd: r?.crowd ?? null,
    timeS: S.timeS,
    selected: S.selected,
  });
  $<HTMLOutputElement>("#clock").value = fmtS(S.timeS);
  $<HTMLInputElement>("#time").value = String(Math.round(S.timeS));
}

// ---- set-up panel ----------------------------------------------------------------------------------------------

function renderPlanHint() {
  const p = S.plan;
  const exits = p.doors.filter((d) => d.b === OUTSIDE).length;
  const problems = checkPlan(p);
  $("#planhint").innerHTML = `${p.rooms.length} rooms, ${p.doors.length} doors, ${exits} to the outside.` +
    (S.notes.length ? `<br>${S.notes.map(esc).join("<br>")}` : "") +
    (problems.length ? `<br><span class="warn">${problems.map(esc).join("<br>")}</span>` : "");
}

function renderScenario() {
  const p = S.plan, s = S.scenario;
  const roomOpts = (sel: string) => p.rooms.map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${esc(r.name)}</option>`).join("");
  const kinds = Object.values(PERSONAS);
  $("#scenario").innerHTML = `
    <div class="field"><span>Fire starts in</span><select data-k="fireRoom">${roomOpts(s.fire.room)}</select></div>
    <div class="field"><span>What burns</span><select data-k="fireItem">${FIRE_ITEMS.map((f) => `<option value="${f.id}" ${f.id === s.fire.item ? "selected" : ""}>${esc(f.label)}${f.source === "measured" ? "" : " (estimate)"}</option>`).join("")}</select></div>
    <div class="field"><span>Alarm after</span><span class="inline"><input type="number" min="0" max="600" step="5" data-k="alarm" value="${s.alarmDelayS}"> s</span></div>
    <h3>Doors locked or blocked</h3>
    <div class="chips">${p.doors.filter((d) => !d.stair).map((d) => `<label class="chip ${s.lockedDoors.includes(d.id) ? "on" : ""}" title="${esc(doorLabel(p, d.id))}"><input type="checkbox" data-door="${d.id}" ${s.lockedDoors.includes(d.id) ? "checked" : ""}>${esc(d.id)}</label>`).join("")}</div>
    <p class="hint">${s.lockedDoors.length ? s.lockedDoors.map((id) => esc(doorLabel(p, id))).join("<br>") : "None. Click a door here or on the plan."}</p>
    <h3>People</h3>
    <div class="groups">${s.occupants.map((o, i) => `
      <div class="group"><input type="number" min="0" max="300" value="${o.count}" data-occ="${i}" data-f="count" aria-label="Number of people">
      <select data-occ="${i}" data-f="kind" aria-label="Who">${kinds.map((k) => `<option value="${k.kind}" ${k.kind === o.kind ? "selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
      <select data-occ="${i}" data-f="room" aria-label="Room">${roomOpts(o.room)}</select>
      <button class="x" data-del="${i}" aria-label="Remove group">×</button></div>`).join("")}</div>
    <div class="row"><button class="btn ghost small" id="addocc">Add people</button><span class="hint">${s.occupants.reduce((n, o) => n + o.count, 0)} people in total.</span></div>`;
}

$("#scenario").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  const s = S.scenario;
  if (t.dataset.k === "fireRoom") s.fire.room = t.value;
  if (t.dataset.k === "fireItem") s.fire.item = t.value;
  if (t.dataset.k === "alarm") s.alarmDelayS = Math.max(0, Math.min(600, Number(t.value) || 0));
  if (t.dataset.door) s.lockedDoors = t.checked ? [...new Set([...s.lockedDoors, t.dataset.door])] : s.lockedDoors.filter((d) => d !== t.dataset.door);
  if (t.dataset.occ !== undefined) {
    const o = s.occupants[Number(t.dataset.occ)]!;
    if (t.dataset.f === "count") o.count = Math.max(0, Math.min(300, Math.round(Number(t.value) || 0)));
    if (t.dataset.f === "kind") o.kind = t.value as PersonaKind;
    if (t.dataset.f === "room") o.room = t.value;
  }
  renderScenario();
  if (!current()) { renderResults(); draw(); }
});
$("#scenario").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "addocc") { S.scenario.occupants.push({ room: S.plan.rooms[0]!.id, count: 5, kind: "customer" }); renderScenario(); }
  if (t.dataset.del !== undefined) { S.scenario.occupants.splice(Number(t.dataset.del), 1); renderScenario(); }
  if ((t.id === "addocc" || t.dataset.del !== undefined) && !current()) renderResults();
});

function loadPlan(plan: Plan, scenario: DrillScenario, notes: string[] = [], fromSample = true) {
  S.fromSample = fromSample;
  // A plan read from a photo or opened from a link gets its own entry in the building list.
  const sel = $<HTMLSelectElement>("#sample");
  sel.querySelector('option[value="-1"]')?.remove();
  if (!fromSample) { sel.insertAdjacentHTML("beforeend", `<option value="-1">${esc(plan.title || "Your plan")}</option>`); sel.value = "-1"; }
  S.plan = plan;
  S.scenario = scenario;
  S.notes = notes;
  S.runs = [];
  S.shown = 0;
  S.timeS = 0;
  S.selected = null;
  S.fixes = null;
  renderPlanHint();
  renderScenario();
  renderRuns();
  renderResults();
  draw();
}

$<HTMLSelectElement>("#sample").addEventListener("change", (e) => {
  const i = Number((e.target as HTMLSelectElement).value);
  if (i < 0) return;
  S.sample = i;
  loadPlan(structuredClone(SAMPLES[i]!.plan), structuredClone(SAMPLES[i]!.scenario));
});

function showError(text: string) { $("#err").textContent = text; }
function setBusy(text: string) {
  if (text) showError("");
  S.busy = text;
  $("#busy").textContent = text;
  for (const id of ["#run", "#parse"]) $<HTMLButtonElement>(id).disabled = !!text;
}

/** Where the smaller AI tasks run: only on the device when the user asked for that, otherwise the device when it has
 *  Gemini Nano (Firebase AI Logic falls back to the cloud by itself), otherwise the cloud. */
const CLOUD_PAUSED = "Gemini in the cloud is paused right now. Rules and Gemini Nano (on a computer that has it) still work.";
/** With cloud AI paused in Remote Config, work that would go to the cloud stays on the device, or stops with a clear message. */
const cloudOk = (w: Where): Where => {
  if (LIMITS.cloudAi || w === "device") return w;
  if (S.device === "available") return "device";
  throw new Error(CLOUD_PAUSED);
};
const aiWhere = (): Where => cloudOk(S.mode === "device" ? "device" : S.device === "available" ? "auto" : "cloud");
/** The plan photo and the fix suggestions need the bigger cloud model unless the user keeps everything local. */
const heavyWhere = (): Where => cloudOk(S.mode === "device" ? "device" : "cloud");

$("#parse").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("#story").value.trim();
  if (!text) { $("#parsesrc").textContent = "Write what happens first."; return; }
  setBusy("Reading the description…");
  try {
    const a = await parseScenario(aiWhere(), S.plan, text);
    S.scenario = toDrill(a.value, S.scenario);
    $("#parsesrc").innerHTML = badge(a.source) + ` ${(a.ms / 1000).toFixed(1)} s. Check the fields below.`;
    renderScenario();
    if (!current()) draw();
  } catch (e) {
    $("#parsesrc").textContent = `Could not read the description: ${String(e).slice(0, 160)}`;
  } finally { setBusy(""); }
});

$<HTMLInputElement>("#photo").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  setBusy("Reading the plan photo…");
  try {
    const base64 = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]!); fr.onerror = rej; fr.readAsDataURL(f); });
    const where = heavyWhere();
    const a = await readPlanPhoto(where, { mimeType: f.type || "image/png", base64 });
    const v = a.value;
    const { plan, notes } = planFromRough(v.title,
      v.rooms.map((r) => ({ id: r.id, name: r.name, floor: r.floor, x: r.x, y: r.y, widthM: r.width_m, depthM: r.depth_m, kind: r.kind, staffOnly: r.staff_only })),
      v.doors.map((d) => ({ from: d.from, to: d.to, widthM: d.width_m, side: d.side, isExit: d.is_exit, exitSign: d.exit_sign, mainEntrance: d.main_entrance })));
    if (!plan.rooms.length) throw new Error("no rooms found on the photo");
    const biggest = [...plan.rooms].filter((r) => !r.staffOnly && r.kind === "room").sort((a, b) => b.widthM * b.depthM - a.widthM * a.depthM)[0] ?? plan.rooms[0]!;
    const staffRoom = plan.rooms.find((r) => r.staffOnly) ?? biggest;
    loadPlan(plan, {
      fire: { room: staffRoom.id, item: "trash_bin" }, lockedDoors: [], occupants: [{ room: biggest.id, count: 20, kind: "customer" }, { room: staffRoom.id, count: 2, kind: "staff" }],
      alarmDelayS: 30, durationS: 600, seed: 7,
    }, [`Read from the photo ${a.source === "on_device" ? "by Gemini Nano on this computer (it often gets doors wrong; check them)" : "in the cloud"} in ${(a.ms / 1000).toFixed(1)} s. Check the rooms and exits before you trust a run.`, ...notes], false);
  } catch (err) {
    S.notes = [`Could not read the photo: ${String(err).slice(0, 180)}`];
    renderPlanHint();
  } finally { setBusy(""); (e.target as HTMLInputElement).value = ""; }
});

function renderMode() {
  const nano = S.device === "available";
  const hint: Record<Mode, string> = {
    standard: "Everyone takes the fastest exit they know about. Instant, no AI.",
    hybrid: nano
      ? "Each person is played by Gemini. Gemini Nano on this computer answers what it can in a few seconds; Gemini in the cloud takes the rest."
      : "Each person is played by Gemini in the cloud. With Gemini Nano on this computer, it would answer first.",
    device: "Gemini Nano plays everyone on this computer. Nothing leaves it, and it is slower.",
  };
  $("#modehint").textContent = hint[S.mode];
}
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.addEventListener("change", () => { S.mode = r.value as Mode; renderDevice(); });

// ---- on-device model ---------------------------------------------------------------------------------------------

function renderDevice() {
  const el = $("#device");
  const st = S.device;
  const text: Record<DeviceStatus, string> = {
    checking: "Checking for Gemini Nano on this computer…",
    available: "Gemini Nano is ready on this computer.",
    downloadable: "Gemini Nano can be downloaded to this computer.",
    downloading: "Gemini Nano is downloading…",
    unavailable: "Gemini Nano is not available on this computer. AI runs use the cloud.",
    "no-api": "This browser has no on-device AI. Use Chrome on a desktop for it; AI runs use the cloud.",
  };
  el.innerHTML = `<span class="dot ${st === "available" ? "ok" : st === "unavailable" || st === "no-api" ? "off" : "wait"}"></span>${text[st]}${st === "downloadable" ? ' <button class="btn ghost small" id="dl">Download (about 2 GB)</button>' : ""}`;
  const dev = document.querySelector<HTMLInputElement>('input[value="device"]')!;
  dev.disabled = st !== "available";
  dev.closest("label")!.title = dev.disabled ? "Needs Gemini Nano on this computer (desktop Chrome)." : "";
  if (dev.disabled && S.mode === "device") { S.mode = "hybrid"; document.querySelector<HTMLInputElement>('input[value="hybrid"]')!.checked = true; }
  renderMode();
  document.getElementById("dl")?.addEventListener("click", async () => {
    S.device = "downloading"; renderDevice();
    try { await prepareDevice((p) => { $("#device").lastChild!.textContent = ` ${Math.round(p * 100)} %`; }); } catch { /* status below says what happened */ }
    S.device = await deviceStatus(); renderDevice();
  });
}

// ---- running -------------------------------------------------------------------------------------------------

async function simulate(plan: Plan, scenario: DrillScenario, mode: Mode, label: string, opts: { replay?: Recording; forceFraction?: number } = {}): Promise<Run> {
  setBusy("Working out how the fire and smoke spread…");
  const forceFraction = opts.replay?.shutOpenFraction ?? opts.forceFraction;
  const { fire, note: fireNote, shutOpenFraction } = await fireForDrill(plan, scenario, setBusy, forceFraction);
  let policy: Policy = standardPolicy;
  let ai: AiStats | null = null;
  let rec: (Policy & { log: RecordedDecision[] }) | null = null;
  if (opts.replay) policy = replayPolicy(opts.replay);
  else if (mode !== "standard") {
    let policyMode: "device" | "cloud" | "hybrid" = mode === "hybrid" && S.device !== "available" ? "cloud" : mode;
    if (!LIMITS.cloudAi && policyMode !== "device") { if (S.device === "available") policyMode = "device"; else throw new Error(CLOUD_PAUSED); }
    const p = aiPolicy(policyMode, (st) => setBusy(`People are deciding what to do… ${st.onDevice} choices by Gemini Nano on this computer, ${st.inCloud} by Gemini in the cloud${st.errors ? `, ${st.errors} questions failed` : ""}`));
    ai = p.stats;
    rec = recordingPolicy(p);
    policy = rec;
  }
  setBusy(mode === "standard" && !opts.replay ? "Moving people…" : "People are deciding what to do…");
  const crowd = await runCrowd(plan, scenario, fire, policy, { fallback: standardPolicy, maxAiCalls: maxAi(mode) });
  return {
    label, plan, scenario, fire, fireNote, hazard: fire ? new HazardField(fire) : null, crowd, mode, ai, shutOpenFraction,
    log: rec?.log ?? opts.replay?.decisions ?? null, recorded: opts.replay ? { model: opts.replay.model, recordedAt: opts.replay.recordedAt, questions: opts.replay.questions, modelSeconds: opts.replay.modelSeconds } : null,
  };
}

const maxAi = (mode: Mode) => (mode === "standard" ? 0 : mode === "device" ? LIMITS.maxAiCallsDevice : LIMITS.maxAiCallsHybrid);

$("#run").addEventListener("click", async () => {
  try {
    const n = S.scenario.occupants.reduce((k, o) => k + o.count, 0);
    if (!n) { setBusy(""); showError("Add some people first."); return; }
    const run = await simulate(structuredClone(S.plan), structuredClone(S.scenario), S.mode, `Run ${S.runs.length + 1}`);
    addRun(run);
  } catch (e) {
    showError(`The run failed: ${String(e).slice(0, 200)}`);
    return;
  } finally { if (S.busy) setBusy(""); }
});

// ---- recorded on-device runs ------------------------------------------------------------------------------------

const recordings = new Map<string, Recording | null>();
async function recordingFor(id: string): Promise<Recording | null> {
  if (!recordings.has(id)) {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}recorded/${id}.json`);
      recordings.set(id, r.ok ? ((await r.json()) as Recording) : null);
    } catch { recordings.set(id, null); }
  }
  return recordings.get(id) ?? null;
}
const sampleUnchanged = () => {
  const smp = SAMPLES[S.sample]!;
  return JSON.stringify(S.plan) === JSON.stringify(smp.plan) && JSON.stringify(S.scenario) === JSON.stringify(smp.scenario);
};
async function renderReplay() {
  const box = document.getElementById("replaybox");
  if (!box) return;
  const smp = SAMPLES[S.sample]!;
  const rec = S.fromSample ? await recordingFor(smp.id) : null;
  if (!rec) { box.innerHTML = ""; return; }
  const ok = sampleUnchanged();
  box.innerHTML = `<h3>No Gemini Nano here?</h3>
    <p class="hint">${ok ? `Play the run Gemini Nano made for this sample on a laptop on ${esc(rec.recordedAt)}. Its choices are replayed; the fire and the crowd are simulated again in your browser.` : "The recorded run is for the sample as it comes. Pick the sample again to play it."}</p>
    <button class="btn ghost" id="replay" ${ok ? "" : "disabled"}>Play the recorded Gemini Nano run</button>`;
  document.getElementById("replay")?.addEventListener("click", async () => {
    try {
      const run = await simulate(structuredClone(S.plan), structuredClone(S.scenario), "device", `Run ${S.runs.length + 1}`, { replay: rec });
      addRun(run);
    } catch (e) { showError(`The recorded run could not be played: ${String(e).slice(0, 200)}`); }
    finally { setBusy(""); }
  });
}

function addRun(run: Run) {
  S.runs.push(run);
  S.shown = S.runs.length - 1;
  S.timeS = 0;
  S.selected = null;
  S.fixes = null;
  renderRuns();
  renderResults();
  play(true);
  // On a phone the plan is below the set-up, so bring it into view.
  if (matchMedia("(max-width: 760px)").matches) $(".stage").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- playback ----------------------------------------------------------------------------------------------------

let last = 0;
function tick(ts: number) {
  if (!S.playing) return;
  const r = current();
  const end = r ? Math.min(r.crowd.endTimeS, r.scenario.durationS) : 0;
  S.timeS = Math.min(end, S.timeS + ((ts - last) / 1000) * S.speed);
  last = ts;
  draw();
  if (S.timeS >= end) { play(false); return; }
  requestAnimationFrame(tick);
}
function play(on: boolean) {
  const r = current();
  if (!r) return;
  S.playing = on;
  $("#play").textContent = on ? "❚❚" : "▶";
  $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) {
    if (S.timeS >= r.crowd.endTimeS - 1) S.timeS = 0;
    last = performance.now();
    requestAnimationFrame(tick);
  }
}
$("#play").addEventListener("click", () => play(!S.playing));
$<HTMLInputElement>("#time").addEventListener("input", (e) => { S.timeS = Number((e.target as HTMLInputElement).value); play(false); draw(); });
$<HTMLSelectElement>("#speed").addEventListener("change", (e) => { S.speed = Number((e.target as HTMLSelectElement).value); });
$<HTMLCanvasElement>("#plan").addEventListener("click", (e) => {
  const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const person = renderer.pick(x, y);
  const door = person === null ? renderer.pickDoor(x, y) : null;
  if (door) {
    const s = S.scenario;
    s.lockedDoors = s.lockedDoors.includes(door) ? s.lockedDoors.filter((d) => d !== door) : [...s.lockedDoors, door];
    renderScenario();
    if (current()) setBusy(`${doorLabel(S.plan, door)} is ${s.lockedDoors.includes(door) ? "now locked" : "open again"} for the next run.`);
    else { renderResults(); draw(); }
    return;
  }
  S.selected = person;
  draw();
  renderResults();
  if (S.selected !== null) document.getElementById(`p${S.selected}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
new ResizeObserver(() => draw()).observe($(".canvaswrap"));

/** Before/after table: the numbers that say whether a change helped. */
function compareTable(a: Run, fa: ReturnType<typeof runFacts>, b: Run, fb: ReturnType<typeof runFacts>) {
  const q = (r: Run) => Math.max(0, ...r.crowd.doors.map((d) => d.maxQueue));
  const rows: [string, number | null, number | null, boolean, (v: number | null) => string][] = [
    ["Got out", fa.out, fb.out, true, (v) => String(v)],
    ["Overcome", fa.incapacitated, fb.incapacitated, false, (v) => String(v)],
    ["Only got out through smoke", fa.outThroughSmoke, fb.outThroughSmoke, false, (v) => String(v)],
    ["Hottest air on the way out", fa.worstTempOutC, fb.worstTempOutC, false, (v) => (v === null ? "–" : `${v} °C`)],
    ["Last one out", fa.lastOutS, fb.lastOutS, false, (v) => (v === null ? "–" : fmtS(v))],
    ["Longest queue at a door", q(a), q(b), false, (v) => String(v)],
  ];
  const cls = (x: number | null, y: number | null, up: boolean) => (x === null || y === null || x === y ? "" : (up ? y > x : y < x) ? "good" : "bad");
  return `<table class="compare"><thead><tr><th></th><th>${esc(a.label.split(":")[0]!)}</th><th>This run</th></tr></thead><tbody>
    ${rows.map(([name, x, y, up, fmt]) => `<tr><td>${name}</td><td>${fmt(x)}</td><td class="${cls(x, y, up)}">${fmt(y)}</td></tr>`).join("")}
  </tbody></table>`;
}

function introHtml() {
  const smp = S.fromSample ? SAMPLES[S.sample] : null;
  const n = S.scenario.occupants.reduce((k, o) => k + o.count, 0);
  return `<div class="intro">
    <h2>${esc(S.plan.title)}</h2>
    ${smp ? `<p class="lede">${esc(smp.blurb)}</p>` : ""}
    <p>${n} people inside. Run the drill to see who gets out, how long it takes, where people queue, and why each person did what they did.</p>
    <h3>Things to try</h3>
    <ul>
      <li>Lock a door by clicking it on the plan, then run again and compare.</li>
      <li>Switch to an AI mode: each person is played by Gemini, with their own reasons.</li>
      <li>After a run, ask Gemini to suggest fixes and test them in one click.</li>
    </ul>
    <div id="replaybox"></div>
  </div>`;
}

// ---- results -----------------------------------------------------------------------------------------------------

const badge = (src: string) => `<span class="badge ${src}">${esc(SOURCE_LABEL[src] ?? src)}</span>`;

function renderRuns() {
  const el = $("#runs");
  if (S.runs.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = S.runs.map((r, i) => {
    const f = runFacts(r.plan, r.fire, r.crowd);
    return `<button class="runtab ${i === S.shown ? "on" : ""}" data-run="${i}"><b>${esc(r.label)}</b><span>${f.out}/${f.total} out${f.incapacitated ? `, ${f.incapacitated} overcome` : ""}</span></button>`;
  }).join("");
}
$("#runs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-run]");
  if (!b) return;
  S.shown = Number(b.dataset.run);
  S.selected = null;
  renderRuns(); renderResults(); draw();
});

function renderResults() {
  const r = current();
  const el = $("#results");
  if (!r) { el.innerHTML = introHtml(); renderReplay(); return; }
  const f = runFacts(r.plan, r.fire, r.crowd);
  $<HTMLInputElement>("#time").max = String(Math.ceil(Math.min(r.crowd.endTimeS, r.scenario.durationS)));
  const bySrc = Object.entries(r.crowd.decisionsBySource).filter(([, n]) => n > 0).map(([k, n]) => `${badge(k)} ${n}`).join(" ");
  const doors = [...r.crowd.doors].filter((d) => d.passed > 0).sort((a, b) => b.passed - a.passed);
  const exitsUnused = r.plan.doors.filter((d) => d.b === OUTSIDE && !doors.some((x) => x.doorId === d.id));
  const people = [...r.crowd.agents].sort((a, b) => {
    const rank = { incapacitated: 0, sheltering: 1, inside: 2, out: 3 } as const;
    return rank[a.outcome] - rank[b.outcome] || (b.timeS ?? 0) - (a.timeS ?? 0);
  });
  const outcome = (a: (typeof people)[number]) =>
    a.outcome === "out" ? `Out by ${a.exitDoor} at ${fmtS(a.timeS!)}${a.smokeS >= 1 ? `, through thick smoke or heat for ${Math.round(a.smokeS)} s (up to ${a.worstTempC} °C)` : ""}` :
    a.outcome === "incapacitated" ? `Overcome by ${a.cause === "co" ? "carbon monoxide" : "heat"} at ${fmtS(a.timeS!)}` :
    a.outcome === "sheltering" ? "Sheltering when the run ended" : "Still inside when the run ended";
  const prevIdx = r.compareTo ?? (S.shown > 0 ? S.shown - 1 : null);
  const prevRun = prevIdx !== null ? S.runs[prevIdx] : undefined;
  const prev = prevRun ? runFacts(prevRun.plan, prevRun.fire, prevRun.crowd) : null;
  const delta = (now: number, before: number | undefined, goodUp: boolean) => {
    if (before === undefined || before === now) return "";
    const better = goodUp ? now > before : now < before;
    return ` <small class="${better ? "good" : "bad"}">${now > before ? "+" : ""}${now - before}</small>`;
  };
  const src = r.crowd.decisionsBySource;
  const how = r.recorded ? (src.cloud ? `People played by Gemini (saved run): ${src.on_device} choices on a computer, ${src.cloud} in the cloud` : "People played by Gemini Nano (saved run)")
    : r.mode === "standard" ? "People follow the rules"
    : r.mode === "device" ? "People played by Gemini Nano on this computer"
    : `People played by Gemini: ${src.on_device} choices on this computer, ${src.cloud} in the cloud`;
  el.innerHTML = `
    <h2>${esc(r.label)}</h2>
    <p class="meta runhow">${how}</p>
    ${r.fixedBy ? `<div class="fixedby">${badge(r.fixedBy.source)} <b>Changes suggested by Gemini:</b> ${esc(r.fixedBy.changes.join(", "))}<ul>${r.fixedBy.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    ${r.fireNote ? `<p class="warn">${esc(r.fireNote)}</p>` : ""}
    ${r.recorded ? `<p class="meta">Choices recorded with ${esc(r.recorded.model)} on ${esc(r.recorded.recordedAt)} (${r.recorded.questions} questions, ${Math.round(r.recorded.modelSeconds)} s of model time) and replayed here. The fire and the crowd are simulated again in your browser.</p>` : ""}
    ${r.ai && r.ai.errors ? `<p class="warn">${r.ai.errors} questions to the AI failed, so some people used the rules instead. Last error: ${esc(r.ai.lastError)}</p>` : ""}
    <div class="tally">
      <div class="t out"><b>${f.out}</b><span>got out of ${f.total}${delta(f.out, prev?.out, true)}</span>${f.outThroughSmoke ? `<span class="smoky">${f.outThroughSmoke} only through smoke${delta(f.outThroughSmoke, prev?.outThroughSmoke, false)}</span>` : prev?.outThroughSmoke ? `<span class="smoky ok">none through smoke${delta(0, prev.outThroughSmoke, false)}</span>` : ""}</div>
      <div class="t down"><b>${f.incapacitated}</b><span>overcome${delta(f.incapacitated, prev?.incapacitated, false)}</span></div>
      <div class="t shelter"><b>${f.sheltering + f.inside}</b><span>still inside</span></div>
      <div class="t time"><b>${f.lastOutS !== null ? fmtS(f.lastOutS) : "–"}</b><span>last one out</span></div>
    </div>
    <p class="meta">${esc(fireItem(r.scenario.fire.item).label)} in ${esc(roomName(r.plan, r.scenario.fire.room))}, alarm at ${r.scenario.alarmDelayS} s${r.scenario.lockedDoors.length ? `, out of use: ${r.scenario.lockedDoors.map(esc).join(", ")}` : ""}. Decisions: ${bySrc}${r.ai && r.ai.calls ? ` <span class="nowrap">(${r.ai.calls} questions, ${(r.ai.ms / 1000).toFixed(0)} s of model time)</span>` : ""}</p>
    ${prevRun && prev ? compareTable(prevRun, prev, r, f) : ""}
    <div class="ai">
      ${r.summary ? `<div class="summary">${badge(r.summary.source)}${mdBullets(r.summary.text)}</div>` : `<button class="btn ghost" id="summ">Explain this run</button>`}
      <button class="btn ghost" id="assess">Suggest fixes and test them</button>
      <button class="btn ghost" id="share">Share this run</button>
      <p class="sharelink" id="sharelink"></p>
    </div>
    <div id="fixes">${renderFixes()}</div>
    <h3>Doors</h3>
    <table class="doors"><thead><tr><th>Door</th><th>People</th><th>Longest queue</th></tr></thead><tbody>
      ${doors.map((d) => `<tr><td>${esc(doorLabel(r.plan, d.doorId))}</td><td>${d.passed}</td><td>${d.maxQueue}</td></tr>`).join("")}
      ${exitsUnused.map((d) => `<tr class="unused"><td>${esc(doorLabel(r.plan, d.id))}</td><td colspan="2">${r.scenario.lockedDoors.includes(d.id) ? "out of use" : "nobody used it"}</td></tr>`).join("")}
    </tbody></table>
    <h3>People</h3>
    <ol class="people">${people.map((a) => `
      <li id="p${a.id}" class="${a.outcome} ${S.selected === a.id ? "sel" : ""}" data-agent="${a.id}">
        <div class="who"><b>${esc(a.name)}</b> <span>${esc(PERSONAS[a.persona].label)}, started in ${esc(roomName(r.plan, a.startRoom))}</span></div>
        <div class="what">${esc(outcome(a))}</div>
        ${S.selected === a.id || a.outcome !== "out" ? `<ol class="dec">${a.decisions.map((d) => `<li><span class="t">${fmtS(d.timeS)}</span> ${badge(d.source)} <b>${esc(d.chosen)}</b>${d.reason ? `<br><q>${esc(d.reason)}</q>` : ""}</li>`).join("")}</ol>` : ""}
      </li>`).join("")}</ol>`;
  document.getElementById("summ")?.addEventListener("click", explain);
  $("#assess").addEventListener("click", assess);
  $("#share").addEventListener("click", share);
}

$("#results").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-agent]");
  if (li && !(e.target as HTMLElement).closest("button")) {
    const id = Number(li.dataset.agent);
    S.selected = S.selected === id ? null : id;
    renderResults();
    draw();
    document.getElementById(`p${id}`)?.scrollIntoView({ block: "nearest" });
  }
  const t = e.target as HTMLElement;
  if (t.id === "tryfix") tryFixes();
});

function mdBullets(text: string) {
  const lines = text.split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").replace(/\*\*/g, "").trim()).filter((l) => l && !/^here'?s/i.test(l));
  return `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}

async function explain() {
  const r = current();
  if (!r) return;
  setBusy("Writing a short reading of this run…");
  try {
    const a = await summariseRun(aiWhere(), factsText(r.plan, r.scenario, r.fire, r.crowd));
    r.summary = { text: a.value, source: a.source };
  } catch (e) { showError(`Could not explain the run: ${String(e).slice(0, 200)}`); }
  finally { setBusy(""); renderResults(); }
}

function renderFixes() {
  if (!S.fixes) return "";
  const fx = S.fixes;
  return `<div class="assess">${badge(fx.source)}<p>${esc(fx.summary)}</p><ul>${fx.findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${fx.fixes.length ? `<h4>Suggested changes</h4><ul class="fixlist">${fx.fixes.map((x) => `<li><b>${esc(fixLabel(x))}</b> ${esc(x.why)}</li>`).join("")}</ul><button class="btn primary" id="tryfix">Re-run with these changes</button>` : ""}</div>`;
}
const fixLabel = (x: Fix) => ({ unlock: `Unlock ${x.door_id}`, keep_open: `Keep ${x.door_id} open`, keep_closed: `Door closer on ${x.door_id}`, add_exit_sign: `Lit exit sign on ${x.door_id}`, widen: `Widen ${x.door_id}` })[x.change];

async function assess() {
  const r = current();
  if (!r) return;
  setBusy("Looking for changes that would help…");
  try {
    const a = await writeAssessment(heavyWhere(), r.plan, factsText(r.plan, r.scenario, r.fire, r.crowd));
    S.fixes = { ...a.value, source: a.source };
  } catch (e) { showError(`Could not suggest fixes: ${String(e).slice(0, 200)}`); }
  finally { setBusy(""); renderResults(); }
}

async function tryFixes() {
  const r = current();
  if (!r || !S.fixes) return;
  const fx = S.fixes;
  const base = S.shown;
  const { plan, scenario, applied } = applyFixes(r.plan, r.scenario, fx.fixes);
  try {
    // A recorded run cannot be replayed with different doors, so a fix is tested with live AI instead.
    const run = await simulate(plan, scenario, r.recorded ? "hybrid" : r.mode, `Run ${S.runs.length + 1}: ${applied.join(", ")}`);
    run.compareTo = base;
    run.fixedBy = { changes: applied, why: fx.fixes.map((x) => x.why), source: fx.source };
    // The changes become the new set-up, so the next run builds on them.
    S.plan = structuredClone(plan);
    S.scenario = structuredClone(scenario);
    renderPlanHint();
    renderScenario();
    addRun(run);
  } catch (e) { showError(`Could not test the changes: ${String(e).slice(0, 200)}`); }
  finally { setBusy(""); }
}

// ---- share links -----------------------------------------------------------------------------------------------

function modelName(r: Run): string {
  if (r.recorded) return r.recorded.model;
  if (r.mode === "standard") return "rules";
  const src = r.crowd.decisionsBySource;
  if (r.mode === "device") return "Gemini Nano in Chrome";
  return src.on_device ? `Gemini Nano in Chrome + ${CLOUD_MODEL}` : CLOUD_MODEL;
}

async function share() {
  const r = current();
  const out = $("#sharelink");
  if (!r) return;
  const btn = $<HTMLButtonElement>("#share");
  btn.disabled = true;
  out.textContent = "Saving…";
  try {
    const id = await saveShare({
      label: r.label.replace(/^Run \d+:?\s*/, "") || r.plan.title || "Fire drill", mode: r.mode, plan: r.plan, scenario: r.scenario, shutOpenFraction: r.shutOpenFraction,
      decisions: r.log ?? [], model: modelName(r), savedAt: r.recorded?.recordedAt ?? new Date().toISOString().slice(0, 10),
      questions: r.ai?.calls ?? r.recorded?.questions ?? 0, modelSeconds: Math.round((r.ai?.ms ?? 0) / 1000) || r.recorded?.modelSeconds || 0,
      ...(r.summary ? { summary: r.summary } : {}), ...(r.fixedBy ? { fixedBy: r.fixedBy } : {}),
    });
    const url = shareUrl(id);
    out.innerHTML = `<a href="${esc(url)}">${esc(url)}</a>`;
    try { await navigator.clipboard.writeText(url); out.insertAdjacentHTML("beforeend", " <span>Copied.</span>"); } catch { /* the link is on screen */ }
  } catch (e) {
    out.textContent = `Could not save the link: ${String(e).slice(0, 160)}`;
  } finally { btn.disabled = false; }
}

/** Opens a shared run: same plan, same scenario, same AI answers; the fire and the crowd are simulated again here. */
async function openShare(id: string) {
  setBusy("Opening the shared run…");
  try {
    const sh: SharedRun | null = await loadShare(id);
    if (!sh) { showError("That share link does not exist or has been deleted."); return; }
    loadPlan(structuredClone(sh.plan), structuredClone(sh.scenario), [], false);
    const replay: Recording | undefined = sh.mode === "standard" ? undefined : {
      schemaVersion: 1, planTitle: sh.plan.title, scenarioSeed: sh.scenario.seed, shutOpenFraction: sh.shutOpenFraction, model: sh.model,
      recordedAt: sh.savedAt, modelSeconds: sh.modelSeconds, questions: sh.questions, decisions: sh.decisions,
    };
    const run = await simulate(structuredClone(sh.plan), structuredClone(sh.scenario), sh.mode, `Shared: ${sh.plan.title}${sh.label && sh.label !== sh.plan.title && sh.label !== "Fire drill" ? `, ${sh.label}` : ""}`, replay ? { replay } : { forceFraction: sh.shutOpenFraction });
    if (sh.summary) run.summary = sh.summary as NonNullable<Run["summary"]>;
    if (sh.fixedBy) run.fixedBy = sh.fixedBy as NonNullable<Run["fixedBy"]>;
    addRun(run);
  } catch (e) { showError(`Could not open the shared run: ${String(e).slice(0, 200)}`); }
  finally { setBusy(""); }
}

// ---- start -------------------------------------------------------------------------------------------------------

loadPlan(S.plan, S.scenario);
document.fonts?.ready.then(() => draw());
deviceStatus().then((st) => { S.device = st; renderDevice(); });
const limitsReady = loadLimits();
const sharedId = new URLSearchParams(location.search).get("s");
if (sharedId) limitsReady.then(() => openShare(sharedId));
renderDevice();

if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__S = S;
  w.__LIMITS = LIMITS;
  // Records a sample with the on-device model and checks that playing it back gives the same run.
  w.__record = async (i: number, model: string): Promise<string> => {
    const smp = SAMPLES[i]!;
    const run = await simulate(structuredClone(smp.plan), structuredClone(smp.scenario), "device", "record");
    const rec: Recording = {
      schemaVersion: 1, planTitle: smp.plan.title, scenarioSeed: smp.scenario.seed, shutOpenFraction: run.shutOpenFraction, model,
      recordedAt: new Date().toISOString().slice(0, 10), modelSeconds: Math.round((run.ai?.ms ?? 0) / 1000), questions: run.ai?.calls ?? 0, decisions: run.log ?? [], bySource: run.crowd.decisionsBySource,
    };
    const again = await simulate(structuredClone(smp.plan), structuredClone(smp.scenario), "device", "check", { replay: rec });
    const sig = (r: Run) => r.crowd.agents.map((a) => `${a.outcome}:${a.timeS}:${a.decisions.length}`).join(",");
    setBusy("");
    return JSON.stringify({ same: sig(run) === sig(again), errors: run.ai?.errors ?? 0, bySource: run.crowd.decisionsBySource, rec });
  };
}
