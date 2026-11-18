# Requirements Document

## Introduction

The fire-zone feature is a TypeScript re-implementation of the core of the NIST CFAST 7.7.7 two-zone compartment fire model. It lives in `src/core/fire/` as pure functions with no DOM access, and it runs in a Web Worker and in Node. Every equation follows the CFAST Technical Reference Guide 7.7.7 (`docs/refs/CFAST_Tech_Ref.pdf`), and every function cites the equation or section it implements.

The model simulates up to 30 compartments plus the outside on up to 6 stacked floors. Each compartment has an upper and a lower gas layer. The model covers wall vents, ceiling and floor vents, leakage, fires with oxygen-limited burning, radiation, convection and conduction heat transfer, gas species, and visibility. A stiff implicit solver advances the state. The output is a time series per compartment and per vent.

Validation against CFAST reference outputs decides whether the project continues (gate on 2026-11-21). CFAST is not bundled or called at runtime. The model is a reference simulation. It never states that a building is safe or compliant (see `.kiro/steering/safety.md`).

Out of scope: sprinklers, detectors, suppression, HVAC and fans, targets, secondary ignition of objects, tenability and FED, crowd movement, and any UI.

## Glossary

- **Fire_Model**: The module in `src/core/fire/` that simulates the compartment fire and returns a result.
- **Input_Validator**: The component of the Fire_Model that checks a Scenario and produces Warnings.
- **Scenario**: The complete input to the Fire_Model: compartments, vents, fires, materials, duration, print interval and seed.
- **Compartment**: A box room defined by width, depth, height, floor elevation and surface materials.
- **Outside**: The ambient environment, treated as an infinite compartment at ambient conditions.
- **Layer**: One of two gas volumes in a Compartment, the upper layer or the lower layer.
- **Interface_Height**: The height above the Compartment floor of the boundary between the upper and lower layers, in metres.
- **Surface_Material**: A material with conductivity, density, specific heat, thickness and emissivity.
- **Wall_Vent**: An opening in a vertical wall (door or window) connecting two Compartments or a Compartment and the Outside (Tech Ref 4.1).
- **Ceiling_Floor_Vent**: An opening in a ceiling or floor connecting two stacked Compartments, such as a stair well, floor opening or roof hatch (Tech Ref 4.2).
- **Leakage_Vent**: A small vent that represents leakage area in a Compartment surface (Tech Ref 4.4).
- **Stair_Compartment**: A Compartment that represents one floor of a stair or vertical shaft and is joined to adjacent floors by Ceiling_Floor_Vents.
- **Fire**: A fuel source with a time table of heat release rate, height, area, CO yield and soot yield, a position, a radiative fraction and fuel chemistry.
- **HRR_Table**: The time table of heat release rate (W) given in the Scenario for a Fire.
- **Burned_HRR**: The heat release rate (W) that the Fire_Model actually releases after applying the oxygen limit.
- **Oxygen_Limit**: The lower oxygen limit below which burning is reduced or stopped (Tech Ref 3.1 and 3.2).
- **Plume_Model**: The component that computes plume entrainment for centre, wall and corner fires (Tech Ref 3.3).
- **Heat_Transfer_Module**: The component that computes fire and layer radiation (Tech Ref 5.1), convection to surfaces (Tech Ref 5.2) and 1-D conduction in surfaces (Tech Ref 5.3).
- **Species_Tracker**: The component that tracks O2, CO2, CO, H2O and soot mass fractions per Layer, optical density and visibility (Tech Ref 6.2).
- **Solver**: The implicit integrator (BDF1/BDF2, Newton iterations, finite-difference Jacobian, adaptive step with error control) described in Tech Ref appendix C.
- **Result**: The output of a run: time series per Compartment, time series per vent, Warnings, and run status.
- **Warning**: A structured message in the Result with a code, a message, a location (Compartment, vent or Fire) and a time.
- **Stair_Flag**: A Warning attached to any Result value that depends on a Stair_Compartment or a Ceiling_Floor_Vent that models a vertical shaft.
- **Print_Interval**: The time spacing of Result samples, 1 s by default.
- **Progress_Event**: A message emitted during a run reporting the simulated time reached and the fraction complete.
- **Worker_Wrapper**: The code in `src/web/` or `src/core/fire/` that runs the Fire_Model inside a Web Worker and forwards Progress_Events and the Result.
- **Reference_Script**: The script `tools/cfast/run-references.sh` that runs a local CFAST 7.7.7 binary on every input in `validation/cases/` and writes CSV files to `validation/reference/`.
- **Validation_Suite**: The test run by `npm run test:validation` that compares Fire_Model output with the reference CSV files.
- **Report_Generator**: The script that writes `validation/REPORT.md` from the Validation_Suite results.
- **Rise**: A layer temperature minus the initial ambient temperature of the Compartment, in kelvin.
- **Seeded_PRNG**: A pseudo-random number generator whose seed is passed in as input.

## Requirements

### Requirement 1: Scenario input and validation

**User Story:** As a developer, I want the Fire_Model to accept a well-defined Scenario and check it, so that bad input produces clear warnings instead of crashes.

#### Acceptance Criteria

1. THE Fire_Model SHALL accept a Scenario with 1 to 30 Compartments inclusive, 1 to 6 distinct floor levels inclusive, and 0 to 60 vents inclusive.
2. THE Fire_Model SHALL express all Scenario and Result quantities in SI units (m, s, kg, K, W, Pa).
3. WHEN a Scenario is received, THE Input_Validator SHALL check that every Compartment has width, depth and height greater than zero, and that every Surface_Material has conductivity, density, specific heat and thickness greater than zero and emissivity between 0 and 1 inclusive.
4. IF a Scenario has fewer than 1 Compartment, more than 30 Compartments, more than 6 distinct floor levels, or more than 60 vents, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the exceeded limit, and SHALL NOT run the simulation.
5. IF a vent references a Compartment that does not exist, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the vent and the missing Compartment, and SHALL NOT run the simulation.
6. IF a vent sill, soffit, width or area lies outside the bounds of the Compartment surface that holds the vent, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the vent and the out-of-bounds field, and SHALL NOT run the simulation.
7. IF an HRR_Table has fewer than 2 rows or more than 10,000 rows, has times that are not strictly increasing, or has a negative time or HRR value, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the Fire and the offending field, and SHALL NOT run the simulation.
8. IF a Fire position lies outside its Compartment, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the Fire, and SHALL NOT run the simulation.
9. IF any numeric input is NaN or infinite, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the field, and SHALL NOT run the simulation.
10. WHEN a Scenario fails more than one check, THE Input_Validator SHALL return a Result with status "invalid" containing one Warning for each failed check.
11. THE Fire_Model SHALL return a Result for every Scenario, including invalid ones, and SHALL throw only when a caller passes a value whose type is not a Scenario object (for example null, undefined, a string, or a number).

### Requirement 2: Compartment geometry and floor stacking

**User Story:** As a developer, I want box rooms with floor elevations on stacked floors, so that multi-storey buildings can be modelled.

#### Acceptance Criteria

1. THE Fire_Model SHALL represent each Compartment as a box defined by width, depth, height and floor elevation, each expressed in metres.
2. IF a Compartment is defined with a width, depth or height that is not a finite number greater than 0 m, or with a floor elevation that is not a finite number, THEN THE Input_Validator SHALL reject the Compartment with a Warning that names the Compartment and the invalid field.
3. THE Fire_Model SHALL represent each Compartment with three surface constructions, one for the ceiling, one for the floor and one shared by all four walls, each of up to three material layers (Tech Ref chapter 5: all walls of a compartment are the same).
4. IF a Compartment surface has neither a Surface_Material nor the explicit adiabatic marker, THEN THE Input_Validator SHALL reject the Compartment with a Warning that names the Compartment and the surface. An explicit adiabatic surface (CFAST material `OFF`, or `&MISC ADIABATIC` for all surfaces) is valid and has zero heat flux into the surface (CFAST 7.7.7 User's Guide keyword appendix; conduction.f90).
5. THE Fire_Model SHALL compute hydrostatic pressure in each Compartment from its floor elevation, so that Compartments on different floors share one ambient pressure profile, where the pressure difference between two Compartments with floor elevations z1 and z2 equals the ambient air density multiplied by gravitational acceleration multiplied by (z2 − z1), within a relative tolerance of 1 %.
6. WHERE a Compartment has a Surface_Material with a layered thickness specification, THE Heat_Transfer_Module SHALL use each layer's conductivity, density, specific heat and thickness in the conduction calculation, with layers ordered from the exposed face inward.
7. IF a layer in a layered Surface_Material has a conductivity, density, specific heat or thickness that is not a finite number greater than 0, THEN THE Input_Validator SHALL reject the Surface_Material with a Warning that names the material and the layer index.
8. IF two Compartments joined by a Ceiling_Floor_Vent have floor elevations and heights that do not stack, meaning the upper Compartment's floor elevation differs from the lower Compartment's floor elevation plus its height by more than 0.01 m, THEN THE Input_Validator SHALL add a Warning that names both Compartments and SHALL continue to accept the input.

### Requirement 3: Two-layer gas state and conservation equations

**User Story:** As a developer, I want the two-layer state equations from the Tech Ref, so that layer temperature, volume and pressure evolve as in CFAST.

#### Acceptance Criteria

1. THE Fire_Model SHALL track, for each Compartment, the upper layer temperature in K, the lower layer temperature in K, the upper layer volume in m³ and the pressure in Pa.
2. THE Fire_Model SHALL use specific heat cp = 1012 J/(kg·K) and heat capacity ratio γ = 1.4 (Tech Ref eq. 2.1).
3. WHEN the Fire_Model advances a Compartment by one time step, THE Fire_Model SHALL update pressure, layer temperatures and upper layer volume with the conservation equations of Tech Ref eq. 2.5 to 2.8.
4. THE Fire_Model SHALL compute Interface_Height in m as the Compartment height minus the quotient of the upper layer volume and the Compartment floor area.
5. WHEN the Fire_Model initialises a Compartment, THE Fire_Model SHALL set the upper and lower layer temperatures to the ambient temperature given in the Scenario, set the pressure to the ambient pressure given in the Scenario, and set the upper layer volume to the minimum layer volume VMIN = min(1e-4 × Compartment volume, 1 m³), so the Interface_Height starts within 1e-4 × the Compartment height of the ceiling (CFAST 7.7.7 source, solve.f90 and initialization.f90).
6. IF an upper layer volume computed in a time step is below VMIN or above the Compartment volume minus VMIN, THEN THE Fire_Model SHALL clamp the upper layer volume to that range (CFAST 7.7.7 source, solve.f90), so that Interface_Height stays between 0 m and the Compartment height inclusive.
7. IF the Scenario gives a Compartment floor area, height, ambient temperature or ambient pressure that is not a finite number greater than 0, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the Compartment and the invalid field, and SHALL NOT initialise any Compartment state.
8. THE Fire_Model SHALL cite the Tech Ref equation or section number in a comment on every function that implements a Tech Ref equation.
9. THE Fire_Model SHALL define every physical constant in a `constants.ts` file in `src/core/fire/` with a comment that cites the Tech Ref section, the case input or the NIST source of the value.

### Requirement 4: Wall vents and leakage

**User Story:** As a developer, I want doors, windows and leakage that exchange gas between Compartments, so that smoke spreads through a building.

#### Acceptance Criteria

1. WHEN the Solver evaluates a Wall_Vent with an open fraction greater than zero, THE Fire_Model SHALL compute the mass flow rate in each direction (kg/s) through the Wall_Vent from the pressure difference between the two connected Compartments, or between a Compartment and the Outside, using the Bernoulli relation with neutral planes (Tech Ref 4.1).
2. WHEN the Solver evaluates a Wall_Vent, THE Fire_Model SHALL assign each flow to the upper layer or lower layer of the source Compartment according to the position of the Interface_Height relative to the vent sill and soffit, so that the flow comes from the upper layer for the part of the vent opening above the Interface_Height and from the lower layer for the part below it.
3. WHERE a Scenario specifies a time table of open fraction for a Wall_Vent, THE Fire_Model SHALL accept a table of 2 to 1,000 (time, open fraction) pairs, with times in seconds, strictly increasing and greater than or equal to 0, and open fractions between 0.0 and 1.0 inclusive, and SHALL linearly interpolate the open fraction between table entries.
4. IF a time table of open fraction contains a value outside 0.0 to 1.0, times that are not strictly increasing, fewer than 2 pairs or more than 1,000 pairs, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that identifies the Wall_Vent and the invalid entry, and SHALL NOT start the simulation.
5. WHEN the open fraction of a Wall_Vent is zero, THE Fire_Model SHALL compute a mass flow rate of exactly 0 kg/s in both directions through that Wall_Vent.
6. WHEN the open fraction of a Wall_Vent changes at a time given in the Scenario, THE Solver SHALL end the current step at that time and restart integration from that time with the initial step size, so that the change is resolved.
7. THE Fire_Model SHALL model leakage as a Leakage_Vent connecting a Compartment and the Outside (Tech Ref 4.4 defines leakage to the outdoors only), with a Scenario-specified area greater than 0 m² and at most 100 m² (Tech Ref 4.4).
8. THE Fire_Model SHALL conserve mass at each Wall_Vent and Leakage_Vent, so that at every output time the total mass flow leaving one Compartment through the vent equals the total mass flow entering the other Compartment or the Outside, within an absolute difference of 1e-9 kg/s or a relative difference of 1e-6, whichever is larger.
9. THE Result SHALL contain, for every Wall_Vent and Leakage_Vent, a time series with one entry at each output time, giving the mass flow rate (kg/s) into and out of each connected Compartment, with upper-layer and lower-layer flows reported separately.
10. IF a Wall_Vent between two Compartments has no vertical overlap with the second Compartment (its sill-to-soffit span, converted to absolute elevation, lies entirely above that Compartment's ceiling or entirely below its floor), THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the Wall_Vent and both Compartments. CFAST 7.7.7 checks the vent bounds against the first Compartment only; a vent that does not reach the second Compartment cannot carry flow into it, and dropping it silently would hide a missing door.

### Requirement 5: Ceiling and floor vents, stairs and shafts

**User Story:** As a developer, I want ceiling and floor vents to connect floors, so that smoke can move up stair wells and floor openings.

#### Acceptance Criteria

1. WHILE a Ceiling_Floor_Vent has an open fraction greater than 0, THE Fire_Model SHALL compute the mass flow rate through that vent at each time step from the pressure difference across the vent (Tech Ref 4.2), in kg/s, with the flow direction following the sign of the pressure difference.
2. THE Fire_Model SHALL support Ceiling_Floor_Vents for open stair wells, floor openings and roof hatches.
3. THE Fire_Model SHALL accept, for each Ceiling_Floor_Vent, a time table of open fraction with 2 to 1,000 (time, fraction) pairs, where time is in seconds, fraction is between 0 and 1 inclusive, and times are strictly increasing.
4. IF a time table of open fraction has fewer than 2 pairs, more than 1,000 pairs, a fraction outside 0 to 1, or times that are not strictly increasing, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the vent and the violated rule.
5. THE Fire_Model SHALL conserve mass at each Ceiling_Floor_Vent in the same way as for Wall_Vents, such that the mass leaving one Compartment through the vent equals the mass entering the connected Compartment, with a relative difference of no more than 1e-6 at every time step.
6. THE Fire_Model SHALL represent a stair as one Stair_Compartment per floor joined by Ceiling_Floor_Vents.
7. WHEN a Result value depends on a Stair_Compartment or on a Ceiling_Floor_Vent that models a vertical shaft, THE Fire_Model SHALL attach a Stair_Flag to that value, citing Tech Ref 1.5 (correlations developed for rooms, not corridors or vertical shafts).
8. WHERE the Scenario marks a Compartment as a corridor or shaft, THE Fire_Model SHALL attach the same Stair_Flag-style Warning to every Result value of that Compartment, citing Tech Ref 1.5. (Tech Ref 1.5 states that there are no hard limits on compartment shape, so the model does not invent a numeric aspect-ratio threshold.) WHERE the Scenario marks a Compartment as a shaft, THE Fire_Model SHALL also compute it as a single well-mixed zone as CFAST 7.7.7 does (upper layer volume held at the Compartment volume minus VMIN, all flows added to the upper layer, lower layer species fractions copied from the upper layer; CFAST 7.7.7 source, solve.f90). A corridor stays a two-zone Compartment with the Warning.
9. IF an input contains a fan, duct or HVAC definition, THEN THE Fire_Model SHALL reject that definition with a Warning that states HVAC is not supported, and SHALL continue to load the remaining input without that definition.

### Requirement 6: Fires, oxygen limit and plume

**User Story:** As a developer, I want fires defined by measured heat release curves with oxygen-limited burning and plume entrainment, so that the model reproduces fire growth and decay in closed rooms.

#### Acceptance Criteria

1. THE Fire_Model SHALL accept for each Fire an HRR_Table with columns time (s, ≥ 0), heat release rate (W, ≥ 0), height (m, ≥ 0), area (m², > 0), CO yield (kg/kg, 0 to 1) and soot yield (kg/kg, 0 to 1), with 2 to 10,000 rows and time strictly increasing from row to row.
2. IF an HRR_Table has fewer than 2 rows, has non-increasing time values, or has a value outside the range stated in criterion 1, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that identifies the row and column at fault, and SHALL leave the Fire undefined.
3. WHEN the simulation time lies between two rows of an HRR_Table, THE Fire_Model SHALL linearly interpolate every column between those rows.
4. WHEN the simulation time is greater than the last row time of an HRR_Table, THE Fire_Model SHALL hold the last row values for every column.
5. THE Fire_Model SHALL accept for each Fire a position (x, y in m) inside the footprint of its Compartment, a radiative fraction from 0 to 1 inclusive, and fuel chemistry given as the numbers of C, H, O, N and Cl atoms (each a non-negative number, with C greater than 0) and a heat of combustion (J/kg, > 0).
6. IF a Fire position lies outside its Compartment footprint, or a radiative fraction or fuel chemistry value lies outside the range stated in criterion 5, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the invalid input, and SHALL leave the Fire undefined.
7. THE Fire_Model SHALL compute Burned_HRR at each time step from the HRR_Table value and the oxygen concentration using the Oxygen_Limit (Tech Ref 3.1 and 3.2).
8. WHILE the oxygen mass fraction in the layer that supplies the Fire is below the Oxygen_Limit, THE Fire_Model SHALL set Burned_HRR below the HRR_Table value at that time.
9. THE Fire_Model SHALL satisfy 0 ≤ Burned_HRR ≤ HRR_Table value at every time step.
10. WHEN the Plume_Model computes entrainment for a Fire, THE Plume_Model SHALL use the free-plume formulation of Tech Ref 3.3, and SHALL apply the corner correction of Tech Ref 3.3.2 (factor 4 on HRR and on D², entrainment divided by 4) only when the fire edge reaches two walls, tested as the distance to each wall ≤ √(fire area)/2. A fire against one wall gets no correction, as in CFAST 7.7.7 (fire.f90, heskestad_plume, whose comment says the V&V experiments show no wall effect). This departs from the Tech Ref 3.3.2 wall correction because the gate compares with CFAST; the report states the departure.
11. THE Fire_Model SHALL add the combustion products of each Fire (CO2, CO, H2O, soot, and consumed O2) to the layer that receives the plume, using the fuel chemistry and yields of the Fire, such that the mass of each species added per time step matches the Tech Ref 3.1 value within 1 %.
12. IF the input contains a sprinkler, detector, suppression or target definition, THEN THE Fire_Model SHALL ignore that definition, SHALL issue a Warning that states the input is not supported and names the item, and SHALL continue the run.
13. THE Fire_Model SHALL compute the upper layer plume with the arguments in their intended meaning (plume height, fire area, wall distances). CFAST 7.7.7 fire.f90 `do_fire` passes them to `heskestad_plume` in a different order for the upper layer call. THE Fire_Model SHALL provide an option `cfastUpperPlumeArgOrder` that reproduces the CFAST order; the Validation_Suite SHALL run each case in both settings, SHALL apply the gate to the CFAST-order run, and SHALL report the difference between the two runs for every case where it is non-zero.

### Requirement 7: Heat transfer

**User Story:** As a developer, I want radiation, convection and conduction, so that layers lose heat to the walls and the surfaces warm up as in CFAST.

#### Acceptance Criteria

1. WHEN the Heat_Transfer_Module advances one time step, THE Heat_Transfer_Module SHALL compute radiation from each Fire as a point source and radiation exchange between each gas layer and each surface it touches (Tech Ref 5.1), using the simplification that the Tech Ref allows.
2. WHEN the Heat_Transfer_Module advances one time step, THE Heat_Transfer_Module SHALL compute convective heat transfer between each gas layer and each surface it touches (Tech Ref 5.2).
3. WHEN the Heat_Transfer_Module advances one time step, THE Heat_Transfer_Module SHALL compute 1-D conduction through each surface with an implicit scheme (Tech Ref 5.3).
4. WHEN the Heat_Transfer_Module advances one time step, THE Heat_Transfer_Module SHALL conserve energy at each surface so that the absolute difference between the heat leaving the gas and the heat entering the surface is at most 1e-6 times the larger of the two values (or at most 1e-9 W if both are below 1e-3 W).
5. THE Heat_Transfer_Module SHALL use the emissivity of each Surface_Material, a value between 0 and 1 inclusive, for radiation absorption.
6. IF a Surface_Material has an emissivity outside 0 to 1 inclusive, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that identifies the Surface_Material and the invalid value, and SHALL NOT run the simulation.
7. WHEN a Scenario has no Fire and all surfaces start at ambient temperature, THE Heat_Transfer_Module SHALL compute a net heat flux of magnitude at most 1e-9 W/m² at every surface at every time step.

### Requirement 8: Species and visibility

**User Story:** As a developer, I want species concentrations and visibility in each layer, so that later specs can judge smoke conditions.

#### Acceptance Criteria

1. THE Species_Tracker SHALL track the mass fractions of O2, CO2, CO, H2O and soot in each Layer of each Compartment, as dimensionless values in kg of species per kg of layer gas.
2. WHEN a simulation starts, THE Species_Tracker SHALL set the mass fraction of each of O2, CO2, CO, H2O and soot in each Layer equal to the corresponding ambient value given in the Scenario.
3. IF the Scenario omits an ambient mass fraction for any of O2, CO2, CO, H2O or soot, THEN THE Input_Validator SHALL return a Result with status "invalid" and a Warning that names the missing species, and SHALL NOT run the simulation.
4. WHEN gas flows through a vent or the plume during a time step, THE Species_Tracker SHALL transfer each species with the mass flow, so that for each species the total mass over all Layers and Compartments changes only by the species mass added by sources or removed through exterior openings, within a relative tolerance of 1e-9.
5. WHEN a time step completes, THE Species_Tracker SHALL compute the optical density and the visibility of each Layer from the soot mass fraction according to Tech Ref 6.2, with optical density in 1/m and visibility in m.
6. IF the soot mass fraction of a Layer is 0, THEN THE Species_Tracker SHALL report the optical density as 0 and the visibility as unbounded, using the same documented representation in every Result.
7. THE Species_Tracker SHALL keep every species mass fraction in each Layer within the range 0 to 1 inclusive, and the sum of the mass fractions of all species and other gas components in each Layer within 1e-9 of 1.
8. IF a computed species mass fraction falls outside 0 to 1 by more than 1e-9 during a time step, THEN THE Fire_Model SHALL stop the run, return a Result with status "failed" and a Warning that identifies the Compartment, Layer, species and time, and retain the samples computed up to the previous time step.
9. THE Result SHALL contain, per Compartment and per Layer, a time series with one value at each output time of the mass fractions of O2, CO2, CO, H2O and soot, the optical density and the visibility.

### Requirement 9: Implicit solver

**User Story:** As a developer, I want a stiff implicit solver with adaptive stepping, so that fast pressure dynamics and slow thermal dynamics are integrated stably.

#### Acceptance Criteria

1. THE Solver SHALL integrate the stiff system of Tech Ref eq. 2.5 to 2.9 with its own implicit BDF1/BDF2 method. Tech Ref appendix C describes how CFAST solves the same system with DASSL (variable-order BDF); the Solver follows that formulation but is not a port of DASSL.
2. WHEN the Solver advances one time step, THE Solver SHALL solve the implicit system with Newton iterations and a finite-difference Jacobian, and SHALL perform at most the maximum Newton iteration count defined in `constants.ts` per step.
3. WHEN a Newton iteration reaches a residual norm at or below the Newton tolerance defined in `constants.ts`, THE Solver SHALL accept the iteration as converged and proceed to the error estimate check.
4. WHEN a time step completes Newton convergence, THE Solver SHALL compute an error estimate, accept the step if the weighted error norm is at most 1.0 using the relative and absolute tolerances defined in `constants.ts`, and otherwise reject the step, reduce the time step, and retry.
5. WHEN a Newton iteration fails to converge within the maximum iteration count, THE Solver SHALL discard the iterate, restore the state from the start of the step, reduce the time step by the reduction factor defined in `constants.ts`, and retry.
6. IF the time step falls below the minimum step defined in `constants.ts`, THEN THE Solver SHALL stop the run, return a Result with status "failed", keep all samples computed before the failing step unchanged, and add a Warning that contains the simulation time of failure in seconds.
7. THE Solver SHALL implement the numeric methods in `src/core/fire/` without an external numeric library, unless the library licence is MIT, BSD or Apache, the version is pinned to an exact number, and the design document justifies it.
8. WHEN the Solver runs twice with identical Scenario input on the same platform and runtime, THE Solver SHALL produce Results whose sample values are bit-identical, including the sequence of accepted time steps.

### Requirement 10: Output time series and progress

**User Story:** As a developer, I want a time series at a fixed interval and progress events, so that a UI can plot and show run progress.

#### Acceptance Criteria

1. WHEN a run ends with status "ok", THE Result SHALL contain, for each Compartment and each sample time, the upper layer temperature in K, the lower layer temperature in K, the Interface_Height in m, the pressure in Pa, the species mass fractions (dimensionless, 0 to 1), the visibility in m, and the Burned_HRR in W of each Fire in the Compartment.
2. THE Fire_Model SHALL produce samples at times t = k × Print_Interval for every integer k from 0 up to and including floor(Scenario duration / Print_Interval), with a default Print_Interval of 1 s, and SHALL also produce a final sample at the Scenario duration if it is not an integer multiple of the Print_Interval.
3. IF the Print_Interval is less than or equal to 0 s, or greater than the Scenario duration, THEN THE Fire_Model SHALL return a Result with status "invalid", add a Warning identifying the Print_Interval, and produce no samples.
4. WHEN the Solver step does not land on a sample time, THE Fire_Model SHALL interpolate or step the Solver so that each sample is evaluated at its sample time with an absolute time error of at most 1e-6 s.
5. WHILE a run is in progress, THE Fire_Model SHALL emit a Progress_Event at least once per 10 simulated seconds, and at least once per 1 s of wall-clock time, each containing the simulated time in s and the fraction complete in the range 0 to 1.
6. WHEN a run ends with status "ok", THE Fire_Model SHALL emit a final Progress_Event with a fraction complete of 1.
7. WHEN a run ends with status "ok", THE Result SHALL contain, for each vent and each sample time, the mass flow in kg/s into and out of each connected Compartment and Outside.
8. WHEN a run ends, THE Result SHALL contain a status of exactly one of "ok", "invalid" or "failed", and a list of Warnings that is empty when there are none.
9. IF a run ends with status "failed", THEN THE Result SHALL contain all samples produced before the failure, and a Warning describing the failure cause and the simulated time at which it occurred.
10. WHERE a Result value is derived from an input flagged with a Warning, THE Result SHALL link that value to that Warning.
11. WHEN the Worker_Wrapper receives a run request, THE Worker_Wrapper SHALL run the Fire_Model in a Web Worker, forward each Progress_Event to the main thread within 100 ms of its emission, and return the Result to the main thread.
12. IF the Web Worker raises an unhandled error, THEN THE Worker_Wrapper SHALL return a Result with status "failed" and a Warning describing the error to the main thread, and SHALL terminate the Web Worker.

### Requirement 11: Robustness and determinism

**User Story:** As a developer, I want the model to be deterministic and never crash, so that results are reproducible and the app stays responsive.

#### Acceptance Criteria

1. WHEN the Fire_Model runs the same Scenario twice in the same runtime, THE Fire_Model SHALL produce Results whose numeric values are bit-identical (compared with `Object.is` on every value) and whose Warnings are identical in content and order.
2. THE Fire_Model SHALL contain zero references to `Math.random` in the files under `src/core/fire/`.
3. WHERE a component needs random numbers, THE Fire_Model SHALL take a Seeded_PRNG as an input, and WHEN the same seed is supplied, THE Fire_Model SHALL produce the same sequence of random values.
4. THE Fire_Model SHALL perform no reads or writes of module-level mutable state, DOM objects, network resources or files, and SHALL produce the same Result when run twice in succession in the same runtime as when run once in a fresh runtime.
5. IF a computed quantity becomes NaN or positive or negative infinity, THEN THE Fire_Model SHALL stop the run at that time step, return a Result with status "failed", retain all Result values computed before that time step, and add one Warning that names the quantity, the Compartment identifier and the simulation time in seconds.
6. IF the Fire_Model fails for any reason other than criterion 5, THEN THE Fire_Model SHALL return a Result with status "failed" (or "invalid" for a Scenario rejected by the Input_Validator) and a Warning describing the cause, and SHALL NOT throw an uncaught exception to the caller.
7. THE Fire_Model SHALL run without source modification in Node 24 and in a Web Worker, and SHALL produce Results whose numeric values are identical in both environments on the same machine for the same Scenario.
8. WHEN a Scenario with 30 Compartments on 6 floors, 60 vents, a duration of 600 s and a Print_Interval of 1 s runs on an M-series Mac in a Web Worker, THE Fire_Model SHALL finish in less than 5 s, measured as wall-clock time from the start message to the Result message and taken as the median of 5 runs.

### Requirement 12: Reference generation with CFAST

**User Story:** As a developer, I want a script that regenerates CFAST reference outputs, so that validation compares against real CFAST 7.7.7 results.

#### Acceptance Criteria

1. WHEN the developer runs the Reference_Script, THE Reference_Script SHALL run a local CFAST 7.7.7 binary on every `.in` file found recursively in `validation/cases/` and SHALL write the resulting reference CSV files to `validation/reference/`.
2. IF the local CFAST binary is missing or its reported version is not 7.7.7, THEN THE Reference_Script SHALL exit with a non-zero exit code, print an error message indicating the missing binary or the version mismatch, and leave the existing files in `validation/reference/` unchanged.
3. THE Fire_Model and the app SHALL NOT bundle, import or call CFAST at runtime.
4. THE `validation/cases/` directory SHALL contain the CFAST verification cases in `Energy_Balance` (2), `Mass_Balance` (4) and `Ventilation/ventilation_4`, the nine Steckler cases 010, 012, 014, 017, 114, 116, 212, 514, 517, and the DelCo Trainers cases Test_02 to Test_06 (21 cases in total). CFAST cases that use mechanical (HVAC) vents are excluded because HVAC is out of scope, and DelCo Test_22 to Test_25 are excluded because they use variable cross-section compartments, which the Tech Ref does not describe.
5. THE Steckler cases SHALL cover door widths of 0.24, 0.49, 0.74 and 0.99 m, and the centre, wall and corner fire positions, so that each door width and each fire position appears in at least one case.
6. THE DelCo Trainers cases SHALL include at least one multi-storey building case with at least one ceiling vent (CFAST Validation Guide 4.2).
7. THE repository SHALL keep the NIST software notice in `validation/NIST-NOTICE.md`, SHALL mark each changed case file with a comment stating that it was changed from the NIST original, and SHALL acknowledge NIST as the source in `validation/NIST-NOTICE.md`.
8. IF a CFAST case fails to run (non-zero exit code from CFAST, or no output CSV produced within 600 seconds), THEN THE Reference_Script SHALL print the case name and the failure reason, continue with the remaining cases, and exit with a non-zero exit code after the last case.
9. THE repository SHALL NOT contain the measured experiment data files of the Steckler or DelCo experiments.

### Requirement 13: Validation against CFAST

**User Story:** As the project owner, I want the model compared with CFAST on all reference cases, so that the gate decision rests on published numbers.

#### Acceptance Criteria

1. WHEN `npm run test:validation` runs, THE Validation_Suite SHALL run the Fire_Model on every case file in `validation/cases/` and compare each Result with the matching file in `validation/reference/`, comparing the time series at the output interval of the CFAST reference file.
2. IF a case in `validation/cases/` has no matching file in `validation/reference/`, THEN THE Validation_Suite SHALL mark that case as failed, SHALL report the case name and the missing reference file, and SHALL continue with the remaining cases.
3. IF the Fire_Model terminates with an error or produces no Result for a case, THEN THE Validation_Suite SHALL mark that case as failed, SHALL report the case name and the error, and SHALL continue with the remaining cases.
4. THE Validation_Suite SHALL exclude all data with a simulated time below 60 s from every comparison.
5. THE Validation_Suite SHALL mark a case as passed only WHEN, at every compared time point from 60 s to the end of the case, the upper layer temperature Rise and the lower layer temperature Rise are each within ±5 % of the CFAST Rise or ±2 K, whichever is larger, the Interface_Height is within ±0.10 m of the CFAST value, and each vent mass flow is within ±10 % of the CFAST value or ±0.005 kg/s, whichever is larger. Reason for the absolute floors: lower layer Rise and vent flows near the neutral plane are close to zero, where a pure percentage tolerance would fail on rounding of the CFAST CSV output rather than on model error.
6. IF a case fails a criterion, THEN THE Validation_Suite SHALL report the case as failed with the quantity, the simulated time in seconds, the CFAST value, the Fire_Model value and the difference, and SHALL keep the criterion unchanged.
7. THE Validation_Suite SHALL change a tolerance only after a written reason has been added to the spec.
8. WHEN the Validation_Suite finishes, THE Report_Generator SHALL write `validation/REPORT.md` with one table per case, listing for each compared quantity the CFAST value, the Fire_Model value, the difference and the pass or fail result.
9. WHEN the Validation_Suite finishes, THE Validation_Suite SHALL exit with code 0 if every case passed and with a non-zero code if any case failed.
10. THE Report_Generator SHALL include for each Steckler case a column with the CFAST value and a column with the measured value, both taken from the CFAST Validation Guide with the page number cited for each value. The Guide prints these only as plots (Appendix C.17), so the values are digitised from the PDF's vector drawing by a script in `tools/` that anyone can re-run, and the report labels them as digitised values. They are not a pass criterion.
11. THE Report_Generator SHALL publish all results, including cases where the Fire_Model differs from CFAST and cases where CFAST differs from measurements, and SHALL NOT omit or alter any case result.
12. THE Report_Generator SHALL state in `validation/REPORT.md` that the model is a reference simulation and that the results do not show that any building is safe or compliant.

### Requirement 14: Property-based tests

**User Story:** As a developer, I want property-based tests for the model invariants, so that bugs outside the reference cases are found.

#### Acceptance Criteria

1. FOR ALL Scenarios with no Fire and all surfaces at ambient temperature, THE Fire_Model SHALL keep every Compartment gas temperature, surface temperature, and pressure within a relative difference of 1e-6 of its ambient value at every output time step for the full run.
2. FOR ALL Scenarios, THE Fire_Model SHALL keep the change of total gas mass summed over all Compartments between time 0 and each output time equal to the cumulative net vent inflow plus the cumulative fuel pyrolysis mass, within a tolerance equal to the largest of: 0.1 % of the larger of the two quantities; 10 × RTOL × the total initial gas mass; or 1e-9 kg. Reason for the RTOL term: the state variables are pressure, upper layer volume and the two layer temperatures (Tech Ref eq. 2.5 to 2.8, the same as CFAST 7.7.7), so total mass is a derived quantity and is conserved only to the time-integration tolerance. A closed 2 m × 2 m × 2 m room with a 1 kW fire showed an error of about 1e-4 of the total gas mass at RTOL = 1e-4, which is 41 % of the tiny mass change from pyrolysis. The same property SHALL also check convergence: with RTOL reduced by a factor of 100, the mass error SHALL fall by at least a factor of 10.
3. FOR ALL closed-room Scenarios (no vent to the outside and no Leakage_Vent), THE Fire_Model SHALL keep the cumulative heat released equal to the gas energy change plus the cumulative heat absorbed by walls plus the cumulative vent outflow of energy, within 1 % of the cumulative heat released, or within 1e-3 J when the cumulative heat released is below 1e-3 J.
4. FOR ALL Scenarios and all output sample times, THE Fire_Model SHALL return an Interface_Height greater than or equal to 0 and less than or equal to the Compartment height, finite temperatures above 0 K, and species mass fractions each between 0 and 1 inclusive whose sum is within 1e-6 of 1.
5. FOR ALL closed-room Scenarios with no Leakage_Vent and a Fire, THE Fire_Model SHALL return an oxygen mass fraction at the end of the run lower than at time 0, and SHALL return a Burned_HRR lower than the HRR_Table value at every output time after the Oxygen_Limit is reached.
6. FOR ALL Scenarios made of two identical mirrored rooms, THE Fire_Model SHALL return Results for both rooms that agree within a relative difference of 1e-9 for every output variable at every output time.
7. FOR ALL Scenarios, WHEN the Fire_Model is run twice with the same input, THE Fire_Model SHALL return Results that are bitwise identical for every output variable at every output time.
8. FOR ALL single-room steady-state Scenarios, THE Fire_Model SHALL return an upper layer temperature that is greater than or equal to the value returned for a lower HRR, with all other inputs equal, and strictly greater when the HRR difference is at least 10 % of the lower HRR.
9. FOR ALL valid random geometries and Fire tables generated within the test generator bounds, THE Fire_Model SHALL return a Result without throwing an exception within a per-run time limit of 10 seconds, and SHALL contain no NaN values in the Result.
10. IF the Fire_Model cannot compute a value for a Scenario, THEN THE Fire_Model SHALL return a Warning identifying the affected variable in place of a NaN value and SHALL preserve all other Result values.
11. THE test suite SHALL run each property with at least 100 fast-check generated cases, and SHALL use fast-check generators that shrink toward the smallest valid Scenario, with one Compartment, one Fire, and no vents.
12. IF a property fails, THEN THE test suite SHALL report the shrunk counterexample Scenario and the random seed so that the failure can be replayed.

### Requirement 15: Reading CFAST input and output files for validation

**User Story:** As a developer, I want the validation cases read straight from the NIST input files, so that the Fire_Model and CFAST run exactly the same scenario.

#### Acceptance Criteria

1. THE repository SHALL contain a CFAST input reader (in `src/core/fire/cfast-input/` or `tools/`) that converts a CFAST 7.7.7 input file into a Scenario, covering the namelist groups used in `validation/cases/`: `&HEAD`, `&TIME`, `&INIT`, `&MISC`, `&MATL`, `&COMP`, `&VENT` with TYPE 'WALL', 'CEILING' or 'FLOOR', `&FIRE`, `&CHEM`, `&TABL` and `&TAIL`, following the CFAST 7.7.7 User's Guide definitions of each keyword.
2. WHEN the CFAST input reader meets `&DEVC`, `&SLCF`, `&DIAG` or any other group that the Fire_Model does not model, THE reader SHALL skip it and add a Warning that names the group, and SHALL continue.
3. IF a CFAST input file contains a `&VENT` with TYPE 'MECHANICAL' or a keyword the reader does not support inside a supported group, THEN THE reader SHALL add a Warning naming the keyword, and THE Validation_Suite SHALL report that case as "unsupported" rather than "passed".
4. THE CFAST input reader SHALL parse input files as data only (no evaluation of file content), SHALL never throw on malformed text, and SHALL return Warnings with the line number of each problem.
5. THE repository SHALL contain a reader for the CFAST `_compartments.csv` and `_vents.csv` output files in `validation/reference/`, which maps the CFAST column names and units to the Result fields used in Requirement 13.
6. FOR ALL validation cases, the Scenario produced by the CFAST input reader SHALL be checked by a test that compares compartment dimensions, vent sizes and the HRR table against the values in the input file.
