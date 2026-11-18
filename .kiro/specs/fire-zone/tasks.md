# Implementation Plan: fire-zone

## Overview

This plan builds the two-zone fire model in `src/core/fire/` bottom-up: types and constants first, then the physics modules (gas, fire, vents, heat, species), the solver, and the assembly into `runFire`. The CFAST input reader, the reference CSV reader, the Reference_Script, the Steckler digitiser, the Worker_Wrapper and the validation harness follow. The performance benchmark and the validation gate (all 21 cases, Requirement 13.5) come last.

Rules that apply to every task:

- Language is TypeScript (strict). The design uses TypeScript, so no language question is needed.
- SI units inside `src/core`. Every constant and correlation carries a source comment (`// Tech Ref eq. X.Y`, `// CFAST 7.7.7 source, <file>.f90, <routine>`, `// numerical parameter, not from Tech Ref`).
- No `Math.random`, no DOM, no `node:*` imports under `src/core/fire/`. No new runtime dependency.
- `runFire` never throws for object input. Warnings never use "safe", "compliant", "certified", "passes" or "meets code" about a building.
- Every test task is required. Property tests are tagged `// Feature: fire-zone, Property N: <title>` and run with `numRuns >= 100`.
- A failing validation case is reported, never loosened. A tolerance change needs a written reason in the spec first (Requirement 13.7).
- `package.json` already has `typecheck` (`tsc --noEmit`), `test` (`vitest run`) and `test:validation` (`vitest run validation`), so no task needs to add them.

## Tasks

- [x] 1. Foundation: types, constants, PRNG, test infrastructure
  - [x] 1.1 Create `types.ts`, `validate/warnings.ts` and `prng.ts`
    - `types.ts`: Scenario, Ambient, Compartment, Surface, SurfaceLayer, Vent variants, Fire, HrrRow, Result, CompartmentSeries, LayerSeries, VentSeries, Warning, ResultFlag, RunOptions, ProgressEvent (shape only, no logic), as in the design's Data Models section
    - `warnings.ts`: exhaustive `WarningCode` union (including `STAIR_OR_SHAFT_LIMIT`, `WORKER_ERROR`, `INTERNAL_ERROR`) and constructors that produce plain-language messages
    - `prng.ts`: `createPrng(seed)` mulberry32-style generator, about ten lines, no `Math.random`
    - _Requirements: 1.2, 10.8, 11.2, 11.3_
  - [x] 1.2 Create `constants.ts` with a source comment on every value
    - cp 1012, γ 1.4, R (Eq. 2.1), g 9.80665 and σ 5.67e-8 (CFAST 7.7.7 prec.f90), VMINFRAC 1e-4 and VMIN cap 1 m³, vent C 0.7, Cm 0.44, ceiling vent 0.68, Cs 0.754 and 0.942, convection C 1.52 and 1.31, Km 8700, K_VIS 3 (FDS User's Guide), oxygen limit 0.15 and tanh form, 1.31e7 J/kg, atomic and molar masses, gas absorption constants (R_atm, M_CO2, M_H2O, soot density 1800, soot constant 1195.5, floor 0.01 1/m), conduction node count 30 and slab split fractions, heat-of-combustion clamp, minimum fire area π/4·0.2², humidity fit constants, `FIRE_PASS_TOL`, ambient pressure profile constants
    - Numerical solver parameters are added in task 8.1 and labelled "numerical parameter, not from Tech Ref"
    - _Requirements: 3.2, 3.8, 3.9, 9.2, 9.3_
  - [x] 1.3 Write static-check and PRNG tests
    - **Property 25: Seeded generator** (same seed gives the same first 1,000 values)
    - **Validates: Requirements 11.3**
    - Static tests: no `Math.random` under `src/core/fire/`; every `constants.ts` entry has a source comment; every exported physics function carries a `Tech Ref` or `NIST` or `CFAST 7.7.7 source` comment; `package.json` has no runtime `dependencies`; `warnings.ts` message templates contain none of the banned words
    - _Requirements: 3.8, 3.9, 9.7, 11.2, 11.3_
  - [x] 1.4 Create `tests/fire/arbitraries.ts` and the fast-check global configuration
    - `arbScenario` shrinks toward one compartment, one fire with a two-row table, no vents; bounds from the design (2 to 8 m, 2 to 4 m high, up to 4 compartments and 3 floors, 5 to 120 s, HRR 0 to 500 kW)
    - `arbDefect`, `arbFlowNetwork`, a 10 s per-run limit helper
    - `fc.configureGlobal({ numRuns: 100, verbose: 1 })` so failures print the shrunk counterexample, seed and path
    - A small test checks that a generated failing property reports a seed and path for replay
    - _Requirements: 14.9, 14.11, 14.12_

- [x] 2. Input_Validator
  - [x] 2.1 Implement `validate/checks.ts` and `validate/validate.ts`
    - One check function per rule from the design (counts, finite-number walk, compartments, surfaces including the adiabatic marker, materials, ambient species, vents, open-fraction tables, fires, output, soft checks); collect every failure; `TypeError` for non-object input
    - Soft checks: stacking mismatch warning, unsupported items dropped with a warning, stair and shaft flags, heat-of-combustion range warning
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 2.2, 2.4, 2.7, 2.8, 3.7, 4.4, 4.7, 5.4, 5.9, 6.2, 6.6, 6.12, 7.6, 8.3, 10.3_
  - [x] 2.2 Write property tests for the validator
    - **Property 1: Validator rejects every injected defect and names it**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.2, 2.4, 2.7, 3.7, 4.4, 5.4, 6.2, 6.6, 7.6, 8.3, 10.3**
    - **Property 3: Size limits are exact**
    - **Validates: Requirements 1.1, 1.4**
  - [x] 2.3 Write unit tests for the validator
    - Explicit adiabatic surface accepted; surface with neither material nor marker rejected; stacking mismatch is a warning and the run continues; unsupported items each give a warning; leakage area bounds (0, 100] m²; non-object argument throws `TypeError`
    - _Requirements: 1.11, 2.4, 2.8, 4.7, 5.9, 6.12_

- [x] 3. Gas state modules
  - [x] 3.1 Implement `gas/layerEquations.ts`, `gas/ambient.ts`, `gas/minVolume.ts`, `gas/layerMixing.ts`
    - Eq. 2.1, 2.4 to 2.8 right-hand sides, interface height with clamping, hydrostatic ambient pressure, VMIN and VMAX, shaft single-zone helpers, CFAST layer mixing (zero when `Tl ≤ Tu`)
    - Each function carries its `// Tech Ref eq. X.Y` or `// CFAST 7.7.7 source` comment
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 5.8_
  - [x] 3.2 Write property and unit tests for the gas modules
    - **Property 4: Hydrostatic pressure difference**
    - **Validates: Requirements 2.5**
    - **Property 5: Interface height stays in range**
    - **Validates: Requirements 3.4, 3.6**
    - **Property 7: Gas equations are consistent with the ideal gas law**
    - **Validates: Requirements 3.1, 3.3**
    - Unit tests: layer mixing is zero when `Tl ≤ Tu`; shaft keeps `Vu` constant and `Tl = Tu`
    - _Requirements: 2.5, 3.1, 3.3, 3.4, 3.6, 5.8_

- [x] 4. Fire modules
  - [x] 4.1 Implement `fire/chemistry.ts`, `fire/heatRelease.ts`, `fire/plume.ts`
    - Eq. 3.1 to 3.9 stoichiometry with CO and soot yields; table interpolation with first-row and last-row hold; ignition time; adiabatic 1 s ramp; heat-of-combustion clamp; minimum fire area; oxygen factor `tanhsmooth` (0 at 0.15, 1 at 0.16); up-to-5-pass lower-layer chemistry; upper-layer burning; Eq. 3.17 to 3.21, 3.27, 3.28 entrainment; corner-only correction with the `x ≤ √A/2` test; weak plume limit
    - `upperPlumeArgs` with the intended order by default and the CFAST order when `cfastUpperPlumeArgOrder` is true
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 6.10, 6.11, 6.13_
  - [x] 4.2 Write property and unit tests for the fire modules
    - **Property 14: HRR table interpolation and hold**
    - **Validates: Requirements 6.1, 6.3, 6.4**
    - **Property 15: Burned HRR is bounded and limited by oxygen**
    - **Validates: Requirements 6.7, 6.8, 6.9**
    - **Property 16: Plume entrainment ordering**
    - **Validates: Requirements 6.10**
    - **Property 17: Combustion products balance the elements**
    - **Validates: Requirements 6.11**
    - Unit tests: oxygen factor is 0 at 0.15 and 1 at 0.16; centre and single-wall positions give the free-plume value and a corner gives the corner value (Steckler positions); the two `cfastUpperPlumeArgOrder` settings differ for an oxygen-limited fire and match a hand calculation with swapped slots, and agree for a lower-layer-only fire
    - _Requirements: 6.3, 6.4, 6.7, 6.8, 6.9, 6.10, 6.11, 6.13_

- [x] 5. Vent modules
  - [x] 5.1 Implement `vents/openFraction.ts`, `vents/wallVent.ts`, `vents/ceilingFloorVent.ts`, `vents/leakage.ts`
    - Open-fraction interpolation with hold outside the range and `breakpoints(table)`; Eq. 4.1 to 4.7 wall vent segments, neutral plane, layer routing, spill plume; Eq. 4.8 to 4.14 ceiling/floor vent; leakage vents to the Outside from area ratios (CFAST `initialize_leakage`); exact zero flow when `height × width × f < 1e-10`; mass conserved by construction
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.5_
  - [x] 5.2 Write property and unit tests for the vent modules
    - **Property 8: Closed vent is exactly closed**
    - **Validates: Requirements 4.5**
    - **Property 9: Vent mass is conserved and routed by interface height**
    - **Validates: Requirements 4.1, 4.2, 4.8, 5.5**
    - **Property 10: Open fraction interpolation** (interpolation, hold and table times as breakpoints; the accepted-step part is tested in task 10.4)
    - **Validates: Requirements 4.3, 5.3**
    - **Property 11: Ceiling vent flow follows the pressure difference**
    - **Validates: Requirements 5.1**
    - Unit test: leakage vent geometry for wall and floor leakage against hand values
    - _Requirements: 4.3, 4.5, 4.7, 4.8, 5.1, 5.5_

- [x] 6. Heat transfer modules
  - [x] 6.1 Implement `heat/configFactors.ts`, `heat/solidAngle.ts`, `heat/gasAbsorptionData.ts`, `heat/gasAbsorption.ts`, `heat/radiation.ts`
    - Eq. 5.1 to 5.20 four-surface exchange, 4 × 4 LU, configuration factors, solid angle, CO₂ and H₂O emissivity tables transcribed with the SFPE Handbook and CFAST 7.7.7 `absorb` citation in the file header, low lower-layer radiation switch-off, point-source fire radiation at one third of the flame height
    - _Requirements: 7.1, 7.4, 7.5_
  - [x] 6.2 Implement `heat/convection.ts` and `heat/conduction.ts`
    - Eq. 5.22, 5.23 convection, ceiling-jet flux replacement rule, 30-node graded grid with 0.50 / 0.17 / 0.33 split, backward Euler tridiagonal solve, interface-node flux continuity, exposed-face Dirichlet with first-order gradient residual, flux back-face boundary with lagged temperature, trial and current profiles, adiabatic option and adiabatic surfaces
    - _Requirements: 2.4, 2.6, 7.2, 7.3, 7.5_
  - [x] 6.3 Write property and unit tests for heat transfer
    - **Property 18: Surface energy balance**
    - **Validates: Requirements 7.4**
    - Unit tests: equal-temperature gray enclosure gives zero net flux; Eq. 5.15 and 5.16 view-factor sums; emissivity table spot values at corners and centre match the CFAST source values; conduction against the analytic semi-infinite solid with a stated error bound; conduction grid has 30 nodes, increasing positions and the smallest spacing at the exposed face; layered materials use each layer's properties
    - _Requirements: 2.6, 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 7. Species and visibility
  - [x] 7.1 Implement `species/tracker.ts` and `species/visibility.ts`
    - Layer masses of O₂, CO₂, CO, H₂O, soot, N₂ and UHC; implicit upwind flux-form update with one shared LU per step; bounds check with the 1e-9 clamp and failure; Eq. 6.3 optical density, `S = 3 / K` visibility with `Infinity` at zero soot, Eq. 6.4 obscuration
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_
  - [x] 7.2 Write property tests for species and visibility
    - **Property 19: Species mass conservation**
    - **Validates: Requirements 8.4, 8.7**
    - **Property 20: Optical density and visibility**
    - **Validates: Requirements 8.5, 8.6**
    - _Requirements: 8.4, 8.5, 8.6, 8.7_

- [x] 8. Implicit solver
  - [x] 8.1 Implement `solver/linalg.ts`, `solver/bdf.ts`, `solver/newton.ts`, `solver/jacobian.ts`, `solver/stepControl.ts`
    - Dense LU with partial pivoting, Thomas solve, variable-step BDF1/BDF2 with predictor and error estimate, modified Newton with refresh rules, coloured forward-difference Jacobian, step acceptance, rejection and Newton-failure reduction, `H_MIN` failure
    - Add the numerical parameters to `constants.ts` (`NEWTON_TOL`, `NEWTON_MAX_ITER`, `RTOL`, `ATOL`, `H_MIN`, `H_MAX`, `H_INITIAL`, `NEWTON_FAIL_REDUCTION`, `STEP_*`, `JAC_REFRESH_H_RATIO`, `NEWTON_SLOW_RATIO`, `DY_O2_MAX`, `M_MIN`), each labelled "numerical parameter, not from Tech Ref"; tune them only with conservation and convergence tests, not against CFAST output
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  - [x] 8.2 Write property and unit tests for the solver
    - **Property 21: BDF integration is exact on low-degree polynomials and converges**
    - **Validates: Requirements 9.1, 9.4**
    - Unit tests: linear test equation `y' = −λ y`; a stiff pressure-relaxation problem; a failing-Newton problem that triggers restore-and-reduce; `H_MIN` failure returns the failure time; LU and Thomas solves against known systems
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [~] 9. Checkpoint - physics modules and solver
  - Run `npm test` and `npm run typecheck`. Ensure both pass, ask the user if questions arise.

- [ ] 10. Assembly: model, residual, driver, `runFire`
  - [x] 10.1 Implement `state.ts`, `model.ts`, `residual.ts`
    - State layout of 8 values per compartment; `buildModel` precomputes geometry, tables, vent topology, leakage vents and the fixed-order graph colouring; `residual.ts` assembles `F(t, y, y')` from the physics modules (Eq. 2.5 to 2.9, C.1, C.2) with `Vu` clamped, shaft mode, preallocated work buffers
    - _Requirements: 2.1, 2.3, 2.5, 3.1, 3.3, 3.5, 3.6, 4.1, 5.8, 6.7, 7.1, 7.2, 7.3, 9.1, 11.4_
  - [x] 10.2 Implement `driver.ts`, `result.ts` and `index.ts` (`runFire`, `validateScenario`)
    - Event list (open-fraction times, HRR table times, sample times), BDF1 restart at events, step shortening to land on samples with history kept, samples at `k * printIntervalS` plus the final time, species update after each accepted step, progress events (10 simulated seconds, injected `now` for the 1 s rule, final event with fraction 1), NaN and infinity detection, species bound failure, top-level `try/catch` returning `INTERNAL_ERROR`, flags for stairs, corridors, shafts and shaft-connected vents, `Result.stats` including `maxUpperBurnHrrW` and optional `stepSizesS`, trimmed arrays on failure, `Infinity` visibility representation
    - _Requirements: 3.5, 4.6, 4.9, 5.7, 5.8, 8.8, 8.9, 9.6, 9.8, 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 11.1, 11.4, 11.5, 11.6, 14.10_
  - [x] 10.3 Write run-level property tests, part A
    - **Property 2: runFire never throws for object input**
    - **Validates: Requirements 1.11, 10.8, 11.6**
    - **Property 6: Initial sample equals ambient**
    - **Validates: Requirements 3.5, 8.2, 8.9**
    - **Property 12: Stair and shaft flags**
    - **Validates: Requirements 5.7, 5.8**
    - **Property 13: Unsupported items are ignored**
    - **Validates: Requirements 5.9, 6.12**
    - **Property 22: Failure keeps earlier samples** (forced failures: Newton, `H_MIN`, injected NaN, species out of bounds)
    - **Validates: Requirements 8.8, 9.6, 10.9, 11.5**
    - **Property 23: Output times and progress**
    - **Validates: Requirements 10.2, 10.4, 10.5, 10.6**
    - Unit test: a throwing physics function injected into `runFire` produces `INTERNAL_ERROR` with earlier samples kept
    - _Requirements: 1.11, 3.5, 5.7, 5.8, 5.9, 6.12, 8.2, 8.8, 9.6, 10.2, 10.4, 10.5, 10.6, 10.8, 10.9, 11.5, 11.6_
  - [x] 10.4 Write run-level property tests, part B
    - **Property 10: Open fraction interpolation** (table times appear as event times in the accepted-step sequence)
    - **Validates: Requirements 4.3, 4.6, 5.3**
    - **Property 24: Determinism and no hidden state** (run A, run B, run A again, and a fresh module instance, compared with `Object.is`, including warnings and the accepted-step sequence)
    - **Validates: Requirements 9.8, 11.1, 11.4, 14.7**
    - **Property 35: Upper plume argument order only matters for upper-layer burning**
    - **Validates: Requirements 6.13**
    - **Property 36: A shaft is a single well-mixed zone**
    - **Validates: Requirements 5.8**
    - _Requirements: 4.3, 4.6, 5.3, 5.8, 6.13, 9.8, 11.1, 11.4, 14.7_
  - [-] 10.5 Write full-run physical property tests
    - **Property 29: Physical invariants of full runs** (no NaN, interface height in `[0, H]`, temperatures finite and above 0 K, species in `[0, 1]` summing to 1 within 1e-6, per-run 10 s limit)
    - **Validates: Requirements 14.4, 14.9, 14.10**
    - **Property 30: No fire at ambient stays at ambient**
    - **Validates: Requirements 7.7, 14.1**
    - **Property 31: Mass and energy balance in full runs**
    - **Validates: Requirements 14.2, 14.3**
    - **Property 32: Closed room with a fire consumes oxygen**
    - **Validates: Requirements 14.5**
    - **Property 33: Mirror symmetry**
    - **Validates: Requirements 14.6**
    - **Property 34: HRR monotonicity**
    - **Validates: Requirements 14.8**
    - _Requirements: 7.7, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.8, 14.9, 14.10, 14.11, 14.12_

- [~] 11. Checkpoint - core model complete
  - Run `npm test` and `npm run typecheck`. Ensure both pass, ask the user if questions arise.

- [x] 12. CFAST input reader
  - [x] 12.1 Implement `cfast-input/` (`tokenize.ts`, `namelist.ts`, `toScenario.ts`, `humidity.ts`, `index.ts`)
    - Hand-written scanner with hard limits (size, group count, tokens), quoted strings, `.TRUE.`/`.FALSE.`; keyword tables with types and units; unit conversions in one place; mapping of `&COMP`, `&VENT` (WALL, CEILING, FLOOR), `&FIRE`/`&CHEM`/`&TABL`, `&MISC`, `&MATL`, leakage ratios, `OFF` as adiabatic, `SHAFT` and `HALL`; humidity saturation fit; skipped groups (`&DEVC`, `&SLCF`, `&CONN`, others) and `unsupported` reasons (mechanical vent, `CROSS_SECT_*`, unknown keyword); line numbers on every warning; never throws, never evaluates text
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 5.8, 4.7, 2.4_
  - [x] 12.2 Write reader tests
    - **Property 26: CFAST input reader is total and reports line numbers**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
    - One test per file in `validation/cases/` (21): parses without throwing, is not `unsupported`, and the Scenario's compartment dimensions, vent sizes and HRR table equal numbers from an independent regular-expression scan of the same file (Requirement 15.6)
    - Fixtures for `unsupported` paths (mechanical vent, `CROSS_SECT_AREAS`, unknown keyword, `&CONN`); humidity at 26 °C and 50 % against the hand-computed CFAST fit value
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.6_

- [x] 13. Reference CSV reader
  - [x] 13.1 Implement `validation/harness/referenceCsv.ts`
    - Four header rows, fixed-width scientific values, column-oriented `Float64Array`s keyed by `{ entity, quantity }`; mapping of `ULT_n`, `LLT_n`, `HGT_n`, `VOL_n`, `PRS_n`, species, `ULOD_n`, `HRR_n` and the vents file columns (`W_*`, `WF_*`, `WT_*`, `L_*`, `CF_*`, `CFT_*`); °C to K and Rise relative to the t = 0 value; sign convention relative to the first compartment of the vent; never throws on malformed text
    - _Requirements: 15.5, 13.1_
  - [x] 13.2 Write reader tests
    - **Property 27: Reference CSV round trip**
    - **Validates: Requirements 15.5**
    - Unit tests on the committed reference files: every one of the 21 case pairs loads; for every wall vent net = (Σ outflow − Σ inflow) of the first compartment; `Steckler_010` at 10 s matches the values in the design
    - _Requirements: 15.5, 13.1_

- [x] 14. Reference_Script
  - [x] 14.1 Extend `tools/cfast/run-references.sh`
    - Check `$CFAST` is set, exists and is executable; run it with no arguments and require a line matching `^Revision[[:space:]]*:[[:space:]]*CFAST-7\.7\.7-`; print the line found and exit non-zero otherwise; touch nothing in `validation/reference/` before the checks pass
    - Per-case timeout of 600 s using `timeout`, `gtimeout` or a background watchdog
    - On non-zero CFAST exit, timeout or missing CSV print `FAILED: <case>: <reason>`, continue, and exit non-zero after the last case (read the file list without a pipeline so the failure counter survives)
    - Write outputs to a temporary directory and copy into `validation/reference/` only when both CSV files exist
    - _Requirements: 12.1, 12.2, 12.3, 12.8_
  - [x] 14.2 Write Reference_Script tests
    - Vitest tests run the script with stub binaries: missing binary, wrong version, a stub that fails or hangs for one case (timeout shortened by an environment override used only in the test), and a good stub; assert exit codes, messages, that remaining cases still run, and that `validation/reference/` is unchanged when the checks fail
    - _Requirements: 12.1, 12.2, 12.8_

- [x] 15. Steckler digitiser
  - [x] 15.1 Implement `tools/steckler/digitise.ts` and `tools/steckler/README.md`
    - Node 24 script run by hand, never by the app or `npm test`; input PDF path defaulting to `docs/refs/CFAST_Validation_Guide.pdf`; the nine tests with PDF and printed pages as constants; `pdftocairo -svg` per page into a temporary directory with a clear message if missing; small hand-written SVG path and circle scanner (data only); axis fit from tick marks; measured maximum and height, CFAST upper-layer temperature and layer height rounded to 0.1 °C and 0.01 m; self-checks (19 measured points, at least 3 ticks per axis, fit residual below 0.5 % of the span) that abort without writing; deterministic output
    - Writes `validation/harness/published/steckler.ts` with a header naming the script, the PDF, the poppler version and the words "digitised, not printed in the Guide", and records `{ test, quantity, unit, cfast, measured, pdfPage, printedPage, digitised: true }`
    - _Requirements: 13.10, 12.9_
  - [x] 15.2 Write digitiser tests
    - Run the SVG parser and axis fit on a small committed synthetic SVG fixture (our own drawing, not Guide content); a self-check failure aborts without writing
    - _Requirements: 13.10_
  - [x] 15.3 Generate `validation/harness/published/steckler.ts` and test it
    - Run the digitiser once and keep the generated file (do not run git commit; the user commits); test that it has 9 rows, each `digitised: true`, with door widths and burner positions matching Table 4.7 and the page numbers in the design table; re-running gives a byte-identical file
    - _Requirements: 13.10, 12.5_

- [ ] 16. Worker_Wrapper
  - [x] 16.1 Implement `worker/protocol.ts`, `src/web/fire/fire.worker.ts`, `src/web/fire/fireClient.ts`
    - Message types `run`, `progress`, `result`, `error`; worker calls `runFire` with `onProgress` and `now: performance.now`, posts each progress event immediately and transfers typed arrays; `runFireInWorker(scenario, onProgress): Promise<Result>` resolves a `failed` Result with a `WORKER_ERROR` warning on `error` or `messageerror`, then terminates the worker
    - _Requirements: 10.5, 10.11, 10.12, 11.7_
  - [~] 16.2 Write Worker_Wrapper tests
    - Smoke test with a fake `Worker`; error path returns `WORKER_ERROR` and terminates; fake-clock test that each progress event is posted at the moment it is emitted; Node versus `worker_threads` adapter running the same module, compared with `Object.is` on every value
    - _Requirements: 10.11, 10.12, 11.7_

- [ ] 17. Validation harness and report
  - [x] 17.1 Implement `validation/harness/tolerances.ts` and `validation/harness/compare.ts`
    - `tolerances.ts` holds only the Requirement 13.5 numbers (60 s, ±5 % or ±2 K, ±0.10 m, ±10 % or ±0.005 kg/s); `compare.ts` aligns samples with CSV rows, drops times below 60 s, checks Rise, interface height and each vent layer flow, records quantity, time, both values and the difference for each failure, and computes the CFAST-order versus intended-order difference (largest value, time, quantity, or "no difference")
    - _Requirements: 13.1, 13.4, 13.5, 13.6, 13.7, 6.13_
  - [x] 17.2 Implement `validation/harness/report.ts` (Report_Generator)
    - Writes `validation/REPORT.md` deterministically: reference-simulation statement (no "safe" or "compliant" claim about any building), summary table with passed, failed and unsupported counts, one table per case with CFAST value, model value, difference and result per quantity plus every failed time point in a collapsible block, the CFAST-order versus intended-order block per case, and for each Steckler case the "CFAST (Validation Guide, digitised)" and "Measured (Validation Guide, digitised)" columns with page numbers and the digitised note; `n/a` only for a test with no entry; no case omitted or altered
    - _Requirements: 13.8, 13.10, 13.11, 13.12, 6.13_
  - [x] 17.3 Write comparator and report tests
    - **Property 28: Comparator verdicts follow the tolerances**
    - **Validates: Requirements 13.4, 13.5, 13.6**
    - Unit tests: report contains the reference-simulation statement and none of the banned words; digitised labels and note present; every case appears; a non-zero plume-order difference is shown and "no difference" is shown when identical; output is deterministic
    - _Requirements: 13.4, 13.5, 13.6, 13.8, 13.10, 13.11, 13.12_
  - [~] 17.4 Implement `validation/cfast.validation.test.ts` (Validation_Suite)
    - Finds every `.in` file under `validation/cases/` recursively and creates one `it` per case; missing reference marks the case failed with the missing path; parser errors and `invalid` or `failed` Results mark it failed with the reason; `unsupported` reader results are failing tests with the message `unsupported: <reason>`, never skipped; every case runs twice (CFAST plume order and intended order), and the verdict comes from the CFAST-order run only; the harness sets `printIntervalS` to the `&TIME SPREADSHEET` value; `afterAll` calls the Report_Generator; any failed or unsupported case fails the run
    - A small harness test with stub cases checks the missing-reference, error, unsupported and two-run behaviour
    - _Requirements: 13.1, 13.2, 13.3, 13.5, 13.6, 13.9, 15.3, 6.13_

- [~] 18. Checkpoint - harness and tooling
  - Run `npm test` and `npm run typecheck`. Ensure both pass, ask the user if questions arise.

- [ ] 19. Performance benchmark
  - [~] 19.1 Implement `tests/fire/bench/fire.bench.test.ts`
    - Opt-in with `FIRE_BENCH=1`; builds the fixed Scenario of 30 compartments on 6 floors, 60 vents, 600 s and a 1 s print interval; runs it through the `worker_threads` adapter from task 16.2; takes the median of 5 runs of start-message to result-message wall time; fails if the median is 5 s or more; prints the median and step statistics
    - If the median exceeds the budget, apply the design's fallback levers in order (Jacobian refresh thresholds, banded LU with reverse Cuthill–McKee ordering, cached vent geometry, fewer nodes) and re-run
    - Add a `test:bench` script to `package.json` (`FIRE_BENCH=1 vitest run tests/fire/bench`)
    - _Requirements: 11.8, 11.7_

- [ ] 20. Validation gate
  - [~] 20.1 Run the Validation_Suite on all 21 cases and publish the report
    - Run `npm run test:validation` against the committed `validation/reference/` files; the gate passes only when all 21 cases pass the Requirement 13.5 criteria in the CFAST-order run
    - Write the regenerated `validation/REPORT.md` as it is (do not run git commit; the user commits), including cases where the model differs from CFAST
    - For a failing case, find and fix the model cause (never loosen a tolerance; a tolerance change needs a written reason in the spec first, Requirement 13.7) and re-run; if a case cannot be fixed, report it plainly and stop for the user's decision
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 13.12, 12.4, 12.5, 12.6_

- [~] 21. Final checkpoint - Ensure all tests pass
  - Run `npm test` and `npm run typecheck`, then `FIRE_BENCH=1 npm run test:bench` and `npm run test:validation`. Ensure all pass, ask the user if questions arise.

## Notes

- No task is optional. Every test task is required.
- Each task lists the requirements it covers. Property test tasks name the design property numbers and the requirement clauses they validate.
- Requirement 14 coverage: 14.1 → P30 (10.5); 14.2, 14.3 → P31 (10.5); 14.4, 14.9, 14.10 → P29 (10.5), with P2 and P22 (10.3); 14.5 → P32 (10.5); 14.6 → P33 (10.5); 14.7 → P24 (10.4); 14.8 → P34 (10.5); 14.11, 14.12 → task 1.4.
- All 36 design properties are assigned: P1, P3 (2.2); P2, P6, P12, P13, P22, P23 (10.3); P4, P5, P7 (3.2); P8, P9, P10, P11 (5.2, 10.4); P14 to P17 (4.2); P18 (6.3); P19, P20 (7.2); P21 (8.2); P24, P35, P36 (10.4); P25 (1.3); P26 (12.2); P27 (13.2); P28 (17.3); P29 to P34 (10.5).
- Tasks 1.2 and 8.1 both edit `constants.ts` and sit in different waves. No other task edits that file.
- The benchmark uses a `worker_threads` adapter in Node as a stand-in for a browser Web Worker. The browser measurement is a manual check.
- The Reference_Script tests use stub binaries. Regenerating references with a real CFAST 7.7.7 binary is a manual step and is not part of this plan.
- This workflow only produces the plan. To execute it, open `tasks.md` and click "Start task" next to a task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "14.1", "15.1"] },
    { "id": 1, "tasks": ["1.2", "13.1", "14.2", "15.2", "15.3"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.1", "3.1", "4.1", "5.1", "6.1", "6.2", "7.1", "8.1", "12.1", "13.2"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2", "4.2", "5.2", "6.3", "7.2", "8.2", "10.1", "12.2", "17.1"] },
    { "id": 4, "tasks": ["10.2", "17.2"] },
    { "id": 5, "tasks": ["10.3", "10.4", "10.5", "16.1", "17.3", "17.4"] },
    { "id": 6, "tasks": ["16.2", "19.1"] },
    { "id": 7, "tasks": ["20.1"] }
  ]
}
```
