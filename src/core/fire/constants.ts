// Physical constants and model constants for the two-zone fire model. SI units (m, s, kg, K, W, Pa).
//
// Every exported constant has a comment directly above it that names its source. Sources used here:
//   - Tech Ref: CFAST Technical Reference Guide 7.7.7 (docs/refs/CFAST_Tech_Ref.pdf)
//   - CFAST 7.7.7 source: Fortran files in docs/refs/cfast-src (reading reference only, no code copied)
//   - FDS User's Guide: visibility relation S = C / K
// Numerical solver parameters are not defined here. They are added in task 8.1 and labelled
// "numerical parameter, not from Tech Ref".

// ---------------------------------------------------------------------------------------------
// Gas properties and universal constants
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 2.1: specific heat of the gas at constant pressure, J/(kg K).
export const CP_J_PER_KG_K = 1012;

// Tech Ref eq. 2.1: ratio of specific heats, dimensionless.
export const GAMMA = 1.4;

// Tech Ref eq. 2.1: gas constant R = (gamma - 1) / gamma * cp, J/(kg K), about 289.14.
export const GAS_R_J_PER_KG_K = ((GAMMA - 1) / GAMMA) * CP_J_PER_KG_K;

// CFAST 7.7.7 source, prec.f90 (grav_con): gravitational acceleration, m/s2. The Tech Ref nomenclature rounds it to 9.8.
export const GRAVITY_M_PER_S2 = 9.80665;

// CFAST 7.7.7 source, prec.f90 (sigma): Stefan-Boltzmann constant, W/(m2 K4).
export const SIGMA_SB_W_PER_M2_K4 = 5.67e-8;

// CFAST 7.7.7 source, prec.f90 (kelvin_c_offset): 0 degC in K.
export const KELVIN_AT_0C = 273.15;

// ---------------------------------------------------------------------------------------------
// Ambient defaults and pressure profile
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, cfast_parameters.f90 (default_temperature): default ambient temperature, K.
export const DEFAULT_AMBIENT_TEMP_K = 293.15;

// CFAST 7.7.7 source, cfast_parameters.f90 (default_pressure): default ambient pressure at the reference elevation, Pa.
export const DEFAULT_AMBIENT_PRESSURE_PA = 101325;

// CFAST 7.7.7 source, cfast_parameters.f90 (default_relative_humidity): default relative humidity, fraction 0 to 1.
export const DEFAULT_RELATIVE_HUMIDITY = 0.5;

// CFAST 7.7.7 source, cfast_parameters.f90 (default_o2_mass_fraction): default ambient oxygen mass fraction, kg/kg.
export const DEFAULT_O2_MASS_FRACTION = 0.23;

// Requirement 2.5, Tech Ref eq. 2.4: hydrostatic ambient profile P(z) = P0 - rho0 g z, with rho0 = P0 / (R T) at the exterior temperature.
// The profile has no free coefficient. This is the reference elevation (floor of the lowest compartment level) at which P0 applies, m.
export const AMBIENT_PRESSURE_REFERENCE_ELEVATION_M = 0;

// ---------------------------------------------------------------------------------------------
// Layer volume limits
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, solve.f90 / initialization.f90 (vminfrac): minimum layer volume as a fraction of compartment volume.
export const VMIN_FRACTION = 1e-4;

// CFAST 7.7.7 source, solve.f90 / initialization.f90: absolute cap on the minimum layer volume, m3. VMIN = min(VMIN_FRACTION V, cap).
export const VMIN_CAP_M3 = 1;

// ---------------------------------------------------------------------------------------------
// Vent flow coefficients
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 4.1 to 4.5 (wall vent flow coefficient C = 0.7); CFAST 7.7.7 source, initialization.f90 (initialize_leakage) uses 0.7 for leakage vents.
export const WALL_VENT_FLOW_COEFFICIENT = 0.7;

// Tech Ref eq. 4.7: spill plume entrainment coefficient Cm = 0.44 (the Tech Ref says 0.44 to 0.66 have been suggested).
export const SPILL_PLUME_ENTRAINMENT_COEFFICIENT = 0.44;

// Tech Ref eq. 4.8, 4.9: ceiling and floor vent flow coefficient.
export const CEILING_VENT_FLOW_COEFFICIENT = 0.68;

// Tech Ref eq. 4.10: shape coefficient Cs for mixing flow through a round ceiling or floor vent.
export const EXCHANGE_SHAPE_COEFFICIENT_ROUND = 0.754;

// Tech Ref eq. 4.10: shape coefficient Cs for mixing flow through a square ceiling or floor vent.
export const EXCHANGE_SHAPE_COEFFICIENT_SQUARE = 0.942;

// CFAST 7.7.7 source, initialization.f90 (initialize_leakage): wall leakage vent sill height as a fraction of the ceiling height.
export const LEAKAGE_WALL_SILL_FRACTION = 0.05;

// CFAST 7.7.7 source, initialization.f90 (initialize_leakage): wall leakage vent soffit height as a fraction of the ceiling height.
export const LEAKAGE_WALL_SOFFIT_FRACTION = 0.95;

// CFAST 7.7.7 source, initialization.f90 (initialize_leakage): floor leakage vent width as a fraction of the mean of compartment width and depth.
export const LEAKAGE_FLOOR_WIDTH_FRACTION = 0.9;

// ---------------------------------------------------------------------------------------------
// Convection
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 5.22, 5.23: convection coefficient constant C for floor and ceiling surfaces, W/(m2 K^(4/3)).
export const CONVECTION_C_HORIZONTAL = 1.52;

// Tech Ref eq. 5.22, 5.23: convection coefficient constant C for wall surfaces, W/(m2 K^(4/3)).
export const CONVECTION_C_WALL = 1.31;

// Tech Ref eq. 5.22, 5.23: exponent on the temperature difference in the natural convection flux, q = C dT^(4/3).
export const CONVECTION_EXPONENT = 4 / 3;

// Tech Ref eq. 5.24 to 5.26, CFAST 7.7.7 source, convection.f90 (convection): coefficient of the early-fire average ceiling flux 0.27 Qc / (A^0.68 H^0.64).
export const CEILING_JET_FLUX_COEFFICIENT = 0.27;

// Tech Ref eq. 5.24 to 5.26, CFAST 7.7.7 source, convection.f90 (convection): ceiling area exponent in the early-fire average ceiling flux.
export const CEILING_JET_AREA_EXPONENT = 0.68;

// Tech Ref eq. 5.24 to 5.26, CFAST 7.7.7 source, convection.f90 (convection): compartment height exponent in the early-fire average ceiling flux.
export const CEILING_JET_HEIGHT_EXPONENT = 0.64;

// ---------------------------------------------------------------------------------------------
// Smoke, visibility
// ---------------------------------------------------------------------------------------------

// Tech Ref eq. 6.3 and CFAST 7.7.7 source, cfast_parameters.f90 (default_sigma_s, flaming value): specific extinction coefficient Km, m2/kg.
export const SPECIFIC_EXTINCTION_COEFFICIENT_M2_PER_KG = 8700;

// FDS User's Guide, VIS_C0 default (based on Jin): visibility S = K_VIS / K for light-reflecting signs. Dimensionless.
export const K_VIS = 3;

// ---------------------------------------------------------------------------------------------
// Fire: oxygen limit, oxygen consumption, chemistry
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, cfast_parameters.f90 (default_lower_oxygen_limit): oxygen mass fraction below which burning stops. Tech Ref eq. 3.15 uses the same value.
export const LOWER_OXYGEN_LIMIT = 0.15;

// CFAST 7.7.7 source, fire.f90 (chemistry, tanhsmooth call): width of the smooth step above the oxygen limit, kg/kg. The factor reaches 1 at limit + width.
export const OXYGEN_LIMIT_WIDTH = 0.01;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth), design.md Fire modules: oxygen factor = clamp(OFFSET + SCALE tanh(SLOPE (Y - Y_limit) - SHIFT), 0, 1). This is OFFSET.
export const OXYGEN_TANH_OFFSET = 0.5;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth), design.md Fire modules: SCALE of the oxygen tanh form (0.5025 so the clamp is reached just inside the width).
export const OXYGEN_TANH_SCALE = 0.5025;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth), design.md Fire modules: SLOPE of the oxygen tanh form, 1/(kg/kg).
export const OXYGEN_TANH_SLOPE = 600;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth), design.md Fire modules: SHIFT of the oxygen tanh form, dimensionless.
export const OXYGEN_TANH_SHIFT = 3;

// CFAST 7.7.7 source, cfast_parameters.f90 (o2f): heat released per kg of oxygen consumed, J/kg. Tech Ref eq. 3.14 uses the same value.
export const HEAT_PER_KG_OXYGEN_J_PER_KG = 1.31e7;

// CFAST 7.7.7 source, input_namelist.f90 (set_heat_of_combustion, hcmin): lower clamp on heat of combustion for rows with positive HRR, J/kg.
export const HEAT_OF_COMBUSTION_MIN_J_PER_KG = 1e6;

// CFAST 7.7.7 source, input_namelist.f90 (set_heat_of_combustion, hcmax): upper clamp on heat of combustion for rows with positive HRR, J/kg.
export const HEAT_OF_COMBUSTION_MAX_J_PER_KG = 1e8;

// CFAST 7.7.7 source, cfast_structures.f90 (pop_table, pio4 * 0.2**2): minimum fire area, m2. Equals pi/4 * 0.2^2.
export const MIN_FIRE_AREA_M2 = (Math.PI / 4) * 0.2 ** 2;

// Numerical parameter, not from Tech Ref: absolute change in burned HRR below which the plume and chemistry passes stop, W.
// The value 1e-5 W and the limit of 5 passes follow CFAST 7.7.7 source, fire.f90 (do_fire), see design.md Fire modules step 6.
export const FIRE_PASS_TOL = 1e-5;

// CFAST 7.7.7 source, fire.f90 (do_fire): maximum number of plume and chemistry passes per fire per evaluation.
export const FIRE_MAX_PASSES = 5;

// ---------------------------------------------------------------------------------------------
// Atomic masses (kg/mol) used for the fuel molar mass
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar_mass): carbon, 12.01 g/mol.
export const ATOMIC_MASS_C_KG_PER_MOL = 12.01e-3;

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar_mass): hydrogen, 1.008 g/mol.
export const ATOMIC_MASS_H_KG_PER_MOL = 1.008e-3;

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar_mass): oxygen, 16.0 g/mol.
export const ATOMIC_MASS_O_KG_PER_MOL = 16.0e-3;

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar_mass): nitrogen, 14.01 g/mol.
export const ATOMIC_MASS_N_KG_PER_MOL = 14.01e-3;

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar_mass): chlorine, 35.45 g/mol.
export const ATOMIC_MASS_CL_KG_PER_MOL = 35.45e-3;

// ---------------------------------------------------------------------------------------------
// Species molar masses (kg/mol) used in the combustion balance and in mole fractions
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, fire.f90 (chemistry): N2, 0.02802 kg/mol.
export const MOLAR_MASS_N2_KG_PER_MOL = 0.02802;

// CFAST 7.7.7 source, fire.f90 (chemistry): O2, 0.032 kg/mol.
export const MOLAR_MASS_O2_KG_PER_MOL = 0.032;

// CFAST 7.7.7 source, fire.f90 (chemistry): CO2, 0.04401 kg/mol.
export const MOLAR_MASS_CO2_KG_PER_MOL = 0.04401;

// CFAST 7.7.7 source, fire.f90 (chemistry): CO, 0.02801 kg/mol.
export const MOLAR_MASS_CO_KG_PER_MOL = 0.02801;

// CFAST 7.7.7 source, fire.f90 (chemistry): HCN, 0.027028 kg/mol.
export const MOLAR_MASS_HCN_KG_PER_MOL = 0.027028;

// CFAST 7.7.7 source, fire.f90 (chemistry): HCl, 0.036458 kg/mol.
export const MOLAR_MASS_HCL_KG_PER_MOL = 0.036458;

// CFAST 7.7.7 source, fire.f90 (chemistry): soot as carbon, 0.01201 kg/mol.
export const MOLAR_MASS_SOOT_KG_PER_MOL = 0.01201;

// CFAST 7.7.7 source, fire.f90 (chemistry): H2O, 0.018016 kg/mol.
export const MOLAR_MASS_H2O_KG_PER_MOL = 0.018016;

// ---------------------------------------------------------------------------------------------
// Gas absorption (radiation)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, radiation.f90 (absorb, rg): ideal gas constant, m3 atm/(mol K).
export const R_ATM_M3_ATM_PER_MOL_K = 82.0562e-6;

// CFAST 7.7.7 source, radiation.f90 (absorb, mwco2): CO2 molar mass, kg/mol.
export const GAS_ABSORPTION_M_CO2_KG_PER_MOL = 44.0088e-3;

// CFAST 7.7.7 source, radiation.f90 (absorb, mwh2o): H2O molar mass, kg/mol.
export const GAS_ABSORPTION_M_H2O_KG_PER_MOL = 18.0153e-3;

// CFAST 7.7.7 source, radiation.f90 (absorb, rhos): soot density, kg/m3.
export const SOOT_DENSITY_KG_PER_M3 = 1800;

// CFAST 7.7.7 source, radiation.f90 (absorb, k): soot absorption constant for typical fuels, 1/(K m).
export const SOOT_ABSORPTION_CONSTANT = 1195.5;

// CFAST 7.7.7 source, radiation.f90 (absorb, final max): floor on the layer absorption coefficient, 1/m.
export const ABSORPTION_COEFFICIENT_FLOOR_PER_M = 0.01;

// CFAST 7.7.7 source, radiation.f90 (radiation, defabsup): default absorption coefficient of the upper layer, 1/m.
export const DEFAULT_ABSORPTION_UPPER_PER_M = 0.5;

// CFAST 7.7.7 source, radiation.f90 (radiation, defabslow): default absorption coefficient of the lower layer, 1/m.
export const DEFAULT_ABSORPTION_LOWER_PER_M = 0.01;

// CFAST 7.7.7 source, radiation.f90 (rad4), design.md "Low lower-layer radiation": lower-layer depth fraction of the ceiling height at or below which lower-layer radiation is switched off.
export const LOW_LAYER_RADIATION_CUTOFF_FRACTION = 1e-4;

// ---------------------------------------------------------------------------------------------
// Conduction
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, cfast_parameters.f90 (nnodes = 61) and cfast_data.f90 (nwpts = (nnodes - 1) / 2): conduction nodes per surface.
export const CONDUCTION_NODE_COUNT = 30;

// CFAST 7.7.7 source, cfast_data.f90 (slab_splits): fraction of nodes given to the inner slab.
export const SLAB_SPLIT_INNER = 0.5;

// CFAST 7.7.7 source, cfast_data.f90 (slab_splits): fraction of nodes given to the middle slab.
export const SLAB_SPLIT_MIDDLE = 0.17;

// CFAST 7.7.7 source, cfast_data.f90 (slab_splits): fraction of nodes given to the outer slab.
export const SLAB_SPLIT_OUTER = 0.33;

// ---------------------------------------------------------------------------------------------
// Humidity (relative humidity to water vapour mass fraction)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient, saturation pressure fit from the Handbook of Physics and Chemistry steam tables): fit constant A in ln(Psat) = A - B / (T - C).
export const HUMIDITY_FIT_A = 23.2;

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient): fit constant B in ln(Psat) = A - B / (T - C), K.
export const HUMIDITY_FIT_B_K = 3.816e3;

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient): fit constant C in ln(Psat) = A - B / (T - C), K.
export const HUMIDITY_FIT_C_K = 46.0;

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient): reference pressure that divides the saturation pressure, Pa.
export const HUMIDITY_REFERENCE_PRESSURE_PA = 101325;

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient): molar mass of water used in the humidity fit, g/mol.
export const HUMIDITY_M_H2O_G_PER_MOL = 18.016;

// CFAST 7.7.7 source, initialization.f90 (initialize_ambient): molar mass of air used in the humidity fit, g/mol.
export const HUMIDITY_M_AIR_G_PER_MOL = 28.584;

// ---------------------------------------------------------------------------------------------
// Layer mixing (added in task 3.1)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, compartments.f90 (layer_mixing): coefficient in q = C (Tl - Tu)^2 A_ceiling when the lower layer is hotter than the upper layer, W/(m2 K2).
export const LAYER_MIXING_COEFFICIENT_W_PER_M2_K2 = 1000;

// CFAST 7.7.7 source, compartments.f90 (layer_mixing, tanhsmooth call): largest value of the mass-flow smoothing factor, reached when the lower layer mass is at least twice the minimum layer mass.
export const LAYER_MIXING_MASS_FACTOR_MAX = 0.5;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth): offset of the smooth step, f = clamp(OFFSET + SCALE tanh(SPAN (x - xmin) / (xmax - xmin) - SHIFT), 0, 1).
export const TANH_SMOOTH_OFFSET = 0.5;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth): scale of the smooth step (0.5025 so that the clamp is reached just inside the interval).
export const TANH_SMOOTH_SCALE = 0.5025;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth): factor that stretches the interval (xmin, xmax) over the tanh argument.
export const TANH_SMOOTH_SPAN = 6;

// CFAST 7.7.7 source, utilities.f90 (tanhsmooth): shift of the tanh argument.
export const TANH_SMOOTH_SHIFT = 3;

// ---------------------------------------------------------------------------------------------
// Species tracker and visibility (added in task 7.1)
// ---------------------------------------------------------------------------------------------

// Requirement 8.8, numerical parameter, not from Tech Ref: a species mass fraction outside 0 to 1 by more than this value stops the run. Smaller excursions are clamped.
export const SPECIES_BOUND_TOL = 1e-9;

// Numerical parameter, not from Tech Ref: layer mass in kg at or below which the species update treats the layer's
// outflow explicitly with the fractions of the previous step instead of dividing by a near-zero mass.
export const SPECIES_MIN_LAYER_MASS_KG = 1e-9;

// Tech Ref eq. 6.4: percent obscuration is 100 (1 - 10^(-Du)), so 100 is the factor that turns a fraction into percent.
export const PERCENT_PER_FRACTION = 100;

// ---------------------------------------------------------------------------------------------
// Convection and conduction details (added in task 6.2)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, convection.f90 (convection, lw_eff): the ceiling-jet correlation is valid for r/H < 4, so the heat transfer area is limited to pi (4 H)^2. This is the factor 4.
export const CEILING_JET_MAX_RADIUS_OVER_HEIGHT = 4;

// CFAST 7.7.7 source, initialization.f90 (initialize_wall_nodes, xb = 0.5 wall_thickness): the grid break point as a fraction of the total wall thickness.
export const CONDUCTION_BREAKPOINT_FRACTION = 0.5;

// CFAST 7.7.7 source, initialization.f90 (initialize_wall_nodes, "if numpts < 1 then numpts = 1"): minimum number of interior nodes in every layer.
export const CONDUCTION_MIN_INTERIOR_NODES_PER_LAYER = 1;

// Tech Ref chapter 5 (up to three layers per surface); CFAST 7.7.7 source, cfast_data.f90 (slab_splits has three entries): largest layer count the node placement handles.
export const CONDUCTION_MAX_LAYERS = 3;

// ---------------------------------------------------------------------------------------------
// Radiation (added in task 6.1)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, radiation.f90 (absorb, rad4 caller): mean beam length L = 1.8 V / (A_floor + d (W + D)). Factor 1.8, dimensionless.
export const MEAN_BEAM_LENGTH_FACTOR = 1.8;

// CFAST 7.7.7 source, radiation.f90 (absorb): weight of the CO2 emissivity in the gas absorptance ag = 0.5 eCO2 + eH2O. SFPE Handbook 1988 ed., pp. 1-99 to 1-101.
export const CO2_ABSORPTANCE_WEIGHT = 0.5;

// CFAST 7.7.7 source, radiation.f90 (radiation): the fire radiates as a point source at one third of the flame height above its base.
export const FIRE_RADIATION_HEIGHT_FRACTION = 1 / 3;

// Numerical guard, not from Tech Ref: upper bound on the gas absorptance ag so that ln(1 - ag) stays finite.
// The tabulated emissivities can sum to slightly more than 1 at the corner of the tables; CFAST 7.7.7 does not guard this.
export const GAS_ABSORPTANCE_MAX = 1 - 1e-6;

// Numerical parameter, not from Tech Ref: pivot magnitude below which the 4 x 4 radiation system is treated as singular.
// CFAST 7.7.7 source, radiation.f90 (rad4) zeroes the solution when its LU factorisation reports a singular matrix.
export const RADIATION_PIVOT_MIN = 1e-300;
// ---------------------------------------------------------------------------------------------
// Implicit solver (added in task 8.1)
// Tech Ref appendix C gives no tolerances, step limits or Newton limits. Every value below is our own choice.
// They are tuned only with conservation and convergence tests, never against CFAST output (design Open Item 10).
// ---------------------------------------------------------------------------------------------
// numerical parameter, not from Tech Ref: Newton convergence tolerance on the weighted RMS norm of the Newton correction (unit: fraction of the RTOL/ATOL error tolerance).
export const NEWTON_TOL = 0.1;
// numerical parameter, not from Tech Ref: largest number of Newton iterations per attempted step (Requirement 9.2).
export const NEWTON_MAX_ITER = 6;
// numerical parameter, not from Tech Ref: Newton is called slow when the ratio of successive correction norms exceeds this value, which refreshes the iteration matrix.
export const NEWTON_SLOW_RATIO = 0.5;
// numerical parameter, not from Tech Ref: the iteration matrix is rebuilt when alpha0 (proportional to 1/h) differs from the factored value by more than this factor.
export const JAC_REFRESH_H_RATIO = 2;
// numerical parameter, not from Tech Ref: relative finite-difference perturbation of the Jacobian, the square root of the double-precision machine epsilon.
export const JAC_PERTURB_RELATIVE = 1.4901161193847656e-8;
// numerical parameter, not from Tech Ref: relative error tolerance of the weighted RMS error norm (Requirement 9.4).
export const RTOL = 1e-4;
// numerical parameter, not from Tech Ref: absolute error tolerance of the gauge pressure, Pa.
export const ATOL_PRESSURE_PA = 1e-3;
// numerical parameter, not from Tech Ref: absolute error tolerance of the upper layer volume, m3.
export const ATOL_VOLUME_M3 = 1e-6;
// numerical parameter, not from Tech Ref: absolute error tolerance of layer and surface temperatures, K.
export const ATOL_TEMPERATURE_K = 1e-3;
// numerical parameter, not from Tech Ref: smallest step before the run is stopped as failed (Requirement 9.6), s.
export const H_MIN = 1e-8;
// numerical parameter, not from Tech Ref: largest step, s.
export const H_MAX = 1;
// numerical parameter, not from Tech Ref: first step after the start or after an event restart (Requirement 4.6), s.
export const H_INITIAL = 1e-3;
// numerical parameter, not from Tech Ref: factor applied to the step after a Newton failure (Requirement 9.5).
export const NEWTON_FAIL_REDUCTION = 0.25;
// numerical parameter, not from Tech Ref: safety factor applied to the step proposed from the error estimate.
export const STEP_SAFETY = 0.9;
// numerical parameter, not from Tech Ref: smallest factor applied to the step after a rejected step.
export const STEP_MIN_FACTOR = 0.2;
// numerical parameter, not from Tech Ref: largest factor applied to the step after a rejected step.
export const STEP_MAX_FACTOR = 0.9;
// numerical parameter, not from Tech Ref: largest growth of the step after an accepted step.
export const STEP_GROWTH_MAX = 2;
// numerical parameter, not from Tech Ref: the step grows only when the proposed factor reaches this value, otherwise it is kept (fewer matrix refreshes).
export const STEP_GROWTH_MIN = 1.2;
// numerical parameter, not from Tech Ref: BDF2 is used only while h / h_previous is at most this value (variable-step BDF2 is unstable above 1 + sqrt(2)); otherwise BDF1 is used.
export const STEP_BDF2_OMEGA_MAX = 2;
// numerical parameter, not from Tech Ref: Newton line search. The full Newton step is shortened by NEWTON_LS_REDUCTION, at most
// NEWTON_LS_MAX_BACKTRACKS times, until the weighted norm of the Newton correction M^-1 G decreases by the fraction
// NEWTON_LS_ARMIJO times the step length.
export const NEWTON_LS_MAX_BACKTRACKS = 4;
// numerical parameter, not from Tech Ref: factor applied to the Newton step length at each backtrack.
export const NEWTON_LS_REDUCTION = 0.5;
// numerical parameter, not from Tech Ref: sufficient-decrease constant of the Newton line search (Armijo form).
export const NEWTON_LS_ARMIJO = 1e-4;
// numerical parameter, not from Tech Ref: number of accepted steps for which the step size is not allowed to grow after a Newton failure cut (stops the cut x0.25 / grow x2 cycle).
export const STEP_HOLD_AFTER_NEWTON_FAIL = 8;

// numerical parameter, not from Tech Ref: largest change of the fire-layer oxygen mass fraction per step, which bounds the species lag of Eq. 3.14 (used by the driver).
export const DY_O2_MAX = 0.01;
// numerical parameter, not from Tech Ref: layer mass at or below which a layer has no outflow row in the species update, kg (used by the species tracker).
export const M_MIN = 1e-10;

// ---------------------------------------------------------------------------------------------
// Vent modules (added in task 5.1)
// ---------------------------------------------------------------------------------------------

// CFAST 7.7.7 source, flowhorizontal.f90 (wall_flow, leakage_flow): a vent with height x effective width below this area is skipped, m2. Gives exact zero flow when closed (Requirement 4.5).
export const VENT_MIN_AREA_M2 = 1e-10;

// CFAST 7.7.7 source, cfast_data.f90 (rptol, passed to the residual as epsp): relative pressure tolerance used to damp very small vent pressure differences to zero.
export const VENT_PRESSURE_EPS = 1e-6;

// CFAST 7.7.7 source, flowhorizontal.f90 (delp): the damping scale is this multiple of epsp times max(1, |dp1|, |dp2|).
export const VENT_DELP_CUT_FACTOR = 10;

// CFAST 7.7.7 source, flowhorizontal.f90 (delp) and flowvertical.f90 (ventcf): beyond this ratio of |dp| to the cut the damping factor is exactly 1 (avoids exp underflow).
export const VENT_DAMPING_CUTOFF_RATIO = 130;

// CFAST 7.7.7 source, flowhorizontal.f90 (flogo) and cfast_parameters.f90 (deltatemp_min): temperature difference over which a vent flow switches between the upper and lower layer of the destination, K.
export const DELTATEMP_MIN_K = 1;

// CFAST 7.7.7 source, flowhorizontal.f90 (poreh_plume): numerator of the lower-layer density used in the spill plume, rho = 352.981915 / T, kg K/m3.
export const SPILL_PLUME_DENSITY_NUMERATOR_KG_K_PER_M3 = 352.981915;

// CFAST 7.7.7 source, flowhorizontal.f90 (spill_plume): factor on the entrainment into the lower layer, approximating reduced Kelvin-Helmholtz mixing.
export const SPILL_PLUME_LOWER_LAYER_FACTOR = 0.25;

// CFAST 7.7.7 source, flowvertical.f90 (ventcf): coefficient on the exchange (mixing) volume flow, dimensionless.
export const EXCHANGE_FLOW_COEFFICIENT = 0.1;

// CFAST 7.7.7 source, flowvertical.f90 (vertical_flow): extraction from a layer fades out between this multiple of the minimum layer volume (full) and EXTRACTION_FADE_LOW_VMIN (none).
export const EXTRACTION_FADE_HIGH_VMIN = 3;

// CFAST 7.7.7 source, flowvertical.f90 (vertical_flow): lower end of the extraction fade, as a multiple of the minimum layer volume.
export const EXTRACTION_FADE_LOW_VMIN = 2;

// CFAST 7.7.7 source, flowvertical.f90 (ventcf): the vent sees a thin layer as absent when its volume is at most this multiple of the minimum layer volume.
export const VENT_THIN_LAYER_VMIN = 2;

// Tech Ref eq. 4.13, 4.14 and CFAST 7.7.7 source, flowvertical.f90 (vertical_flow): plug-holing weight alpha = exp(-(Fr / divisor)^2).
export const PLUG_HOLING_FROUDE_DIVISOR = 2;

// ---------------------------------------------------------------------------------------------
// Driver (added in task 10.2)
// ---------------------------------------------------------------------------------------------

// Requirement 10.5, numerical parameter, not from Tech Ref: simulated time between progress events, s. The driver lands a step on every multiple of this value.
export const PROGRESS_SIM_INTERVAL_S = 10;

// Requirement 10.5, numerical parameter, not from Tech Ref: wall-clock time between progress events, in the unit of the injected clock (milliseconds, as performance.now).
export const PROGRESS_WALL_INTERVAL_MS = 1000;

// Requirement 10.4, numerical parameter, not from Tech Ref: an event (sample, table time, progress mark) closer than this to the accepted time counts as reached, s. Well below the 1e-6 s limit of Requirement 10.4.
export const EVENT_SNAP_S = 1e-7;

// Requirement 10.2, numerical parameter, not from Tech Ref: if the last multiple of the print interval is within this of the duration, no separate final sample is added, s.
export const FINAL_SAMPLE_TOL_S = 1e-9;
