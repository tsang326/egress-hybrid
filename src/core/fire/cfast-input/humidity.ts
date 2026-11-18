// Relative humidity to the ambient species of a Scenario, the way CFAST 7.7.7 builds its initial atmosphere.
// Pure functions, SI units.
//
// CFAST 7.7.7 source, initialization.f90 (initialize_species): water vapour mass fraction = RH * x_sat, where
// x_sat = Psat(T) / 101325 Pa * (18.016 / 28.584) and Psat(T) = exp(23.2 - 3816 / (T - 46)) Pa for T in K.
// Dry air is N2 0.77 and O2 0.23 (mass fractions); the three are then normalised to sum to 1.
import {
  DEFAULT_O2_MASS_FRACTION,
  HUMIDITY_FIT_A,
  HUMIDITY_FIT_B_K,
  HUMIDITY_FIT_C_K,
  HUMIDITY_M_AIR_G_PER_MOL,
  HUMIDITY_M_H2O_G_PER_MOL,
  HUMIDITY_REFERENCE_PRESSURE_PA,
} from "../constants";
import type { Ambient } from "../types";

/** Saturation pressure of water in Pa from the CFAST fit. Not finite when tempK is 46 K. */
export function saturationPressurePa(tempK: number): number {
  return Math.exp(HUMIDITY_FIT_A - HUMIDITY_FIT_B_K / (tempK - HUMIDITY_FIT_C_K));
}

/** CFAST saturation mass factor x_sat at tempK (the water vapour mass fraction at 100 % humidity, before normalising). */
export function saturationMassFactor(tempK: number): number {
  return (saturationPressurePa(tempK) / HUMIDITY_REFERENCE_PRESSURE_PA) * (HUMIDITY_M_H2O_G_PER_MOL / HUMIDITY_M_AIR_G_PER_MOL);
}

/** Ambient species mass fractions at the interior temperature. `relativeHumidity` is a fraction (0.5 for 50 %). */
export function ambientSpecies(tempK: number, relativeHumidity: number): Ambient["species"] {
  const n2 = 1 - DEFAULT_O2_MASS_FRACTION;
  const h2oRaw = relativeHumidity * saturationMassFactor(tempK);
  const total = n2 + DEFAULT_O2_MASS_FRACTION + h2oRaw;
  return {
    o2: DEFAULT_O2_MASS_FRACTION / total,
    co2: 0,
    co: 0,
    h2o: h2oRaw / total,
    soot: 0,
  };
}
