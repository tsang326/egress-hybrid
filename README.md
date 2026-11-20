# Egress

Run a fire drill on your building's floor plan before you run it for real. Gemini plays every person inside:
Gemini Nano on your laptop first, Gemini in the cloud for the rest, through Firebase AI Logic.

Live: https://egress-hybrid-mntd.web.app (desktop Chrome; Gemini Nano is optional)

**This is a model for understanding risks. It is not a fire safety assessment and does not replace a review by the
fire authority or an engineer.**

## What it does

1. Pick a building (café, office, three-floor shared house) or read one from a photo of a floor plan.
2. Say where the fire starts, what burns, when the alarm goes off, which doors are locked, and who is inside. You can
   also type it as a sentence and let Gemini fill the form.
3. Run the drill. A two-zone fire and smoke model (re-implemented from the method of NIST CFAST 7.7.7) runs in a Web
   Worker; people move, queue at doors and breathe what the fire model says is in their room. When something happens
   to them (alarm, smoke, a blocked door, waiting too long), Gemini decides what they do and why.
4. Read the result: who got out, who was overcome, who only got out through thick smoke or hot air, every person's
   choices with the model that made them.
5. "Suggest fixes and test them": Gemini proposes door changes (unlock, keep open, door closer, exit sign, widen);
   one click re-runs the drill with them and shows both runs side by side.
6. "Share this run": a link that replays the same run in anyone's browser.

## Where the AI runs

All calls go through `getGenerativeModel` from `firebase/ai` (`src/web/app/firebase.ts`).

| Task | Code | Runs on |
|---|---|---|
| People's decisions | `aiPolicy` in `src/web/app/ai.ts` | Hybrid: Nano takes as many groups as it answers in about 8 s per decision moment, the cloud takes the rest in parallel, failed Nano groups go to the cloud. Or Nano only, or no AI (rules). |
| Scenario from a sentence | `parseScenario` | Nano when available (`PREFER_ON_DEVICE`), else cloud |
| Floor plan from a photo | `readPlanPhoto` | Cloud (`gemini-3.5-flash`); Nano in "on this computer only" mode |
| Explain a run | `summariseRun` | Nano when available, else cloud |
| Suggest fixes | `writeAssessment` | Cloud; Nano in "on this computer only" mode |

Every answer records `response.inferenceSource`, and the app shows it next to each choice.

Browsers without Gemini Nano can play a run Nano recorded on a laptop (`public/recorded/*.json`). The crowd model is
deterministic, so feeding back the recorded answers reproduces the run (`src/core/crowd/recorded.ts`,
`tests/recorded.test.ts`).

## Firebase

- AI Logic with the Gemini Developer API (`gemini-3.5-flash-lite` for decisions and text, `gemini-3.5-flash` for photos).
- App Check with reCAPTCHA Enterprise, enforced on AI Logic and Firestore.
- Firestore + anonymous Auth for share links (`src/web/app/share.ts`, `firestore.rules`).
- Remote Config: `cloud_ai` pauses all cloud calls, `max_ai_calls_hybrid` and `max_ai_calls_device` cap AI questions
  per run (`src/web/app/limits.ts`, `remoteconfig.template.json`).
- Hosting (`firebase.json`).

## Run it locally

Needs Node 22 or newer and a Firebase project with AI Logic (Gemini Developer API), App Check and, for share links, Firestore
and anonymous Auth.

```sh
npm ci
# App Check debug token for local development (register it in the Firebase console under App Check > Manage debug tokens)
echo "VITE_APPCHECK_DEBUG_TOKEN=<your debug token>" > .env.development.local
npm run dev
```

To use your own project, replace `firebaseConfig` in `src/web/app/firebase.ts`. For a production build, put your
reCAPTCHA Enterprise site key in `.env.production` as `VITE_RECAPTCHA_ENTERPRISE_KEY`, then `npm run build` and
`firebase deploy`.

Gemini Nano: desktop Chrome on macOS 13+, Windows 10+ or Linux, 16 GB RAM or a GPU with more than 4 GB, about 22 GB
free disk. The app shows a Download button when Chrome can fetch the model.

Tests: `npm test` (about 4 minutes; the fire model has property-based tests).

## Layout

- `src/core/fire` two-zone fire and smoke model
- `src/core/crowd` crowd model, personas, recorded runs
- `src/core/plan` plans, samples, things that burn, scenarios
- `src/core/report.ts` run facts and fixes
- `src/web` the app
- `validation` CFAST 7.7.7 reference outputs and the comparison harness (a model-vs-CFAST report is not published yet)
- `.kiro` specs and steering used to build the fire model

## Credits and licence

Fire model method: NIST CFAST 7.7.7. Files from NIST keep the NIST notice (`validation/NIST-NOTICE.md`).
Everything else: MIT, see `LICENSE`.
