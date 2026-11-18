// Combustion stoichiometry (Tech Ref section 3.1, eq. 3.1 to 3.9).
// Pure functions. Masses in kg, rates in kg/s, molar masses in kg/mol.
import {
  ATOMIC_MASS_C_KG_PER_MOL,
  ATOMIC_MASS_CL_KG_PER_MOL,
  ATOMIC_MASS_H_KG_PER_MOL,
  ATOMIC_MASS_N_KG_PER_MOL,
  ATOMIC_MASS_O_KG_PER_MOL,
  MOLAR_MASS_CO2_KG_PER_MOL,
  MOLAR_MASS_CO_KG_PER_MOL,
  MOLAR_MASS_H2O_KG_PER_MOL,
  MOLAR_MASS_HCL_KG_PER_MOL,
  MOLAR_MASS_HCN_KG_PER_MOL,
  MOLAR_MASS_N2_KG_PER_MOL,
  MOLAR_MASS_O2_KG_PER_MOL,
  MOLAR_MASS_SOOT_KG_PER_MOL,
} from "../constants";

// Atom counts of the fuel molecule C(nC) H(nH) O(nO) N(nN) Cl(nCl); the counts may be fractional.
export interface FuelAtoms {
  c: number;
  h: number;
  o: number;
  n: number;
  cl: number;
}

// Yields in kg of species per kg of fuel burned (Tech Ref eq. 3.2 to 3.4).
export interface ProductYields {
  coYield: number;
  sootYield: number;
  hcnYield: number; // v1 passes 0; the fuel nitrogen then reverts to N2 (Tech Ref after eq. 3.9)
}

// Stoichiometric coefficients of eq. 3.1, per mole of fuel.
export interface Stoichiometry {
  nuO2: number;
  nuCO2: number;
  nuH2O: number;
  nuCO: number;
  nuSoot: number;
  nuHCl: number;
  nuHCN: number;
  nuN2: number;
}

// Mass rates in kg/s. Products are positive (produced). Fuel and O2 are negative (consumed).
export interface SpeciesRates {
  fuel: number;
  o2: number;
  co2: number;
  co: number;
  h2o: number;
  soot: number;
  hcl: number;
  hcn: number;
  n2: number;
}

// CFAST 7.7.7 source, input_namelist.f90 (read_chem, molar mass from atom counts): M_F in kg/mol.
export function fuelMolarMassKgPerMol(fuel: FuelAtoms): number {
  return (
    fuel.c * ATOMIC_MASS_C_KG_PER_MOL +
    fuel.h * ATOMIC_MASS_H_KG_PER_MOL +
    fuel.o * ATOMIC_MASS_O_KG_PER_MOL +
    fuel.n * ATOMIC_MASS_N_KG_PER_MOL +
    fuel.cl * ATOMIC_MASS_CL_KG_PER_MOL
  );
}

// Tech Ref eq. 3.2 to 3.9. Coefficients per mole of fuel. No clamping: a physically impossible yield (for example
// more carbon in CO and soot than the fuel has) gives a negative coefficient, which the Input_Validator and the
// caller must catch. The element balance of eq. 3.1 holds for whatever the inputs are.
export function stoichiometry(fuel: FuelAtoms, yields: ProductYields): Stoichiometry {
  const mF = fuelMolarMassKgPerMol(fuel);
  const nuSoot = (mF / MOLAR_MASS_SOOT_KG_PER_MOL) * yields.sootYield; // eq. 3.2
  const nuCO = (mF / MOLAR_MASS_CO_KG_PER_MOL) * yields.coYield; // eq. 3.3
  const nuHCN = Math.min(fuel.n, (mF / MOLAR_MASS_HCN_KG_PER_MOL) * yields.hcnYield); // eq. 3.4
  const nuHCl = fuel.cl; // eq. 3.8
  const nuCO2 = fuel.c - (nuCO + nuHCN + nuSoot); // eq. 3.5
  const nuH2O = (fuel.h - (nuHCl + nuHCN)) / 2; // eq. 3.6
  const nuO2 = nuCO2 + (nuH2O + nuCO - fuel.o) / 2; // eq. 3.7
  const nuN2 = (fuel.n - nuHCN) / 2; // eq. 3.9
  return { nuO2, nuCO2, nuH2O, nuCO, nuSoot, nuHCl, nuHCN, nuN2 };
}

// Tech Ref eq. 3.1 converted to mass rates (CFAST 7.7.7 source, fire.f90, chemistry): species rate =
// pyrolysis rate * nu * M_species / M_F. burnedFuelKgS is the fuel mass rate that actually burns.
export function speciesRates(burnedFuelKgS: number, fuel: FuelAtoms, nu: Stoichiometry): SpeciesRates {
  const mF = fuelMolarMassKgPerMol(fuel);
  const perMole = mF > 0 ? burnedFuelKgS / mF : 0; // moles of fuel burned per second
  return {
    fuel: -burnedFuelKgS,
    o2: -perMole * nu.nuO2 * MOLAR_MASS_O2_KG_PER_MOL,
    co2: perMole * nu.nuCO2 * MOLAR_MASS_CO2_KG_PER_MOL,
    co: perMole * nu.nuCO * MOLAR_MASS_CO_KG_PER_MOL,
    h2o: perMole * nu.nuH2O * MOLAR_MASS_H2O_KG_PER_MOL,
    soot: perMole * nu.nuSoot * MOLAR_MASS_SOOT_KG_PER_MOL,
    hcl: perMole * nu.nuHCl * MOLAR_MASS_HCL_KG_PER_MOL,
    hcn: perMole * nu.nuHCN * MOLAR_MASS_HCN_KG_PER_MOL,
    n2: perMole * nu.nuN2 * MOLAR_MASS_N2_KG_PER_MOL,
  };
}

// Tech Ref eq. 3.1 to 3.9 (section 3.1): the all-zero SpeciesRates, the identity for the sums of species rates.
export function zeroRates(): SpeciesRates {
  return { fuel: 0, o2: 0, co2: 0, co: 0, h2o: 0, soot: 0, hcl: 0, hcn: 0, n2: 0 };
}

// Tech Ref eq. 3.1 to 3.9 (section 3.1): every species rate is linear in the burn rate, so scaling the rates by a factor scales the burn rate.
export function scaleRates(rates: SpeciesRates, factor: number): SpeciesRates {
  return {
    fuel: rates.fuel * factor,
    o2: rates.o2 * factor,
    co2: rates.co2 * factor,
    co: rates.co * factor,
    h2o: rates.h2o * factor,
    soot: rates.soot * factor,
    hcl: rates.hcl * factor,
    hcn: rates.hcn * factor,
    n2: rates.n2 * factor,
  };
}

// Tech Ref eq. 3.1 to 3.9 (section 3.1): species rates from separate burn contributions (lower and upper layer) add.
export function addRates(a: SpeciesRates, b: SpeciesRates): SpeciesRates {
  return {
    fuel: a.fuel + b.fuel,
    o2: a.o2 + b.o2,
    co2: a.co2 + b.co2,
    co: a.co + b.co,
    h2o: a.h2o + b.h2o,
    soot: a.soot + b.soot,
    hcl: a.hcl + b.hcl,
    hcn: a.hcn + b.hcn,
    n2: a.n2 + b.n2,
  };
}
