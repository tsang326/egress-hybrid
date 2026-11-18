// Warning codes and constructors (design: Warnings and flags; Req 1.4 to 1.10, 5.7 to 5.9, 6.12, 10.10, 11.5, 11.6).
// Messages are plain language. They never give a verdict on a building (see the safety steering rules
// for the banned wording). A unit test scans this file for those words, so they are not listed here.

export type WarningCode =
  // Scenario limits (Req 1.1, 1.4)
  | "LIMIT_COMPARTMENTS"
  | "LIMIT_FLOORS"
  | "LIMIT_VENTS"
  // Generic input checks
  | "NOT_FINITE"
  | "INVALID_DIMENSION"
  | "INVALID_ELEVATION"
  | "SURFACE_MISSING"
  | "SURFACE_LAYER_COUNT"
  | "MATERIAL_INVALID"
  | "EMISSIVITY_RANGE"
  | "AMBIENT_INVALID"
  | "AMBIENT_SPECIES_MISSING"
  | "AMBIENT_SPECIES_RANGE"
  | "DUPLICATE_ID"
  // Vents
  | "VENT_COMPARTMENT_MISSING"
  | "VENT_OUT_OF_BOUNDS"
  | "VENT_AREA_INVALID"
  | "VENT_NO_VERTICAL_OVERLAP"
  | "OPEN_TABLE_INVALID"
  | "LEAKAGE_AREA_INVALID"
  // Fires
  | "FIRE_COMPARTMENT_MISSING"
  | "FIRE_OUTSIDE_COMPARTMENT"
  | "FIRE_RADIATIVE_FRACTION"
  | "FIRE_FUEL_INVALID"
  | "HRR_TABLE_INVALID"
  // Output settings (Req 10.3)
  | "DURATION_INVALID"
  | "PRINT_INTERVAL_INVALID"
  // Soft input warnings
  | "STACKING_MISMATCH"
  | "UNSUPPORTED_ITEM"
  | "HEAT_OF_COMBUSTION_RANGE"
  | "STAIR_OR_SHAFT_LIMIT"
  // Run-time failures
  | "SOLVER_STEP_TOO_SMALL"
  | "NON_FINITE_STATE"
  | "SPECIES_OUT_OF_RANGE"
  | "UNCOMPUTABLE_OUTPUT"
  | "INTERNAL_ERROR"
  | "WORKER_ERROR"
  // Input readers
  | "CFAST_PARSE"
  | "CFAST_UNSUPPORTED"
  | "CFAST_INPUT_TOO_LARGE";

export type WarningLocation = {
  kind: "scenario" | "compartment" | "vent" | "fire" | "material" | "row" | "field";
  id?: string;
  field?: string;
  row?: number;
  column?: string;
};

export interface Warning {
  code: WarningCode;
  severity: "error" | "warning";
  message: string;
  location: WarningLocation;
  timeS: number | null; // null for input-time warnings
  source?: string; // e.g. "Tech Ref 1.5"
}

interface WarningInit {
  code: WarningCode;
  severity: "error" | "warning";
  message: string;
  location: WarningLocation;
  timeS?: number | null;
  source?: string | undefined;
}

function make(init: WarningInit): Warning {
  const w: Warning = {
    code: init.code,
    severity: init.severity,
    message: init.message,
    location: init.location,
    timeS: init.timeS ?? null,
  };
  if (init.source !== undefined) w.source = init.source;
  return w;
}

/** Limit exceeded (Req 1.4). */
export function limitExceeded(
  code: "LIMIT_COMPARTMENTS" | "LIMIT_FLOORS" | "LIMIT_VENTS",
  actual: number,
  rule: string,
): Warning {
  return make({
    code,
    severity: "error",
    message: `The scenario has ${actual}, but the model accepts ${rule}. The simulation was not started.`,
    location: { kind: "scenario" },
  });
}

/** A numeric field is NaN or infinite (Req 1.9). `path` is the field path, e.g. "compartments[0].widthM". */
export function notFinite(path: string): Warning {
  return make({
    code: "NOT_FINITE",
    severity: "error",
    message: `The value of ${path} is not a finite number. The simulation was not started.`,
    location: { kind: "field", field: path },
  });
}

/** A compartment dimension, elevation, ambient value or similar field is out of range. */
export function invalidField(
  code: "INVALID_DIMENSION" | "INVALID_ELEVATION" | "AMBIENT_INVALID" | "VENT_AREA_INVALID",
  location: WarningLocation,
  field: string,
  requirement: string,
): Warning {
  const who = location.id !== undefined ? ` of ${location.kind} "${location.id}"` : "";
  return make({
    code,
    severity: "error",
    message: `The field ${field}${who} must be ${requirement}. The simulation was not started.`,
    location: { ...location, field },
  });
}

/** A compartment surface has neither layers nor the adiabatic marker (Req 2.4). */
export function surfaceMissing(compartmentId: string, surface: string): Warning {
  return make({
    code: "SURFACE_MISSING",
    severity: "error",
    message: `Compartment "${compartmentId}" has no material for its ${surface}. Give it a material or mark it as adiabatic.`,
    location: { kind: "compartment", id: compartmentId, field: surface },
  });
}

/** A surface has 0 or more than 3 layers (Tech Ref chapter 5). */
export function surfaceLayerCount(compartmentId: string, surface: string, count: number): Warning {
  return make({
    code: "SURFACE_LAYER_COUNT",
    severity: "error",
    message: `The ${surface} of compartment "${compartmentId}" has ${count} layers. It needs 1 to 3 layers.`,
    location: { kind: "compartment", id: compartmentId, field: surface },
    source: "Tech Ref chapter 5",
  });
}

/** A material layer value is not a finite number above zero (Req 1.3, 2.7). */
export function materialInvalid(material: string, layerIndex: number, field: string): Warning {
  return make({
    code: "MATERIAL_INVALID",
    severity: "error",
    message: `Material "${material}", layer ${layerIndex}: ${field} must be a finite number greater than 0.`,
    location: { kind: "material", id: material, field: `layers[${layerIndex}].${field}` },
  });
}

/** Emissivity outside 0 to 1 (Req 7.6). */
export function emissivityRange(material: string, layerIndex: number, value: number): Warning {
  return make({
    code: "EMISSIVITY_RANGE",
    severity: "error",
    message: `Material "${material}", layer ${layerIndex}: emissivity ${value} is outside the range 0 to 1.`,
    location: { kind: "material", id: material, field: `layers[${layerIndex}].emissivity` },
  });
}

/** An ambient species mass fraction is missing (Req 8.3). */
export function ambientSpeciesMissing(species: string): Warning {
  return make({
    code: "AMBIENT_SPECIES_MISSING",
    severity: "error",
    message: `The ambient mass fraction of ${species} is missing. The simulation was not started.`,
    location: { kind: "field", field: `ambient.species.${species}` },
  });
}

/** An ambient species mass fraction is outside 0 to 1. */
export function ambientSpeciesRange(species: string, value: number): Warning {
  return make({
    code: "AMBIENT_SPECIES_RANGE",
    severity: "error",
    message: `The ambient mass fraction of ${species} is ${value}. It must be between 0 and 1.`,
    location: { kind: "field", field: `ambient.species.${species}` },
  });
}

/** Two items share one id. */
export function duplicateId(kind: "compartment" | "vent" | "fire", id: string): Warning {
  return make({
    code: "DUPLICATE_ID",
    severity: "error",
    message: `More than one ${kind} uses the id "${id}". Each id must be unique.`,
    location: { kind, id },
  });
}

/** A vent names a compartment that does not exist (Req 1.5). */
export function ventCompartmentMissing(ventId: string, compartmentId: string): Warning {
  return make({
    code: "VENT_COMPARTMENT_MISSING",
    severity: "error",
    message: `Vent "${ventId}" refers to compartment "${compartmentId}", which does not exist.`,
    location: { kind: "vent", id: ventId },
  });
}

/** A vent sill, soffit, width or area lies outside its surface (Req 1.6). */
export function ventOutOfBounds(ventId: string, field: string, detail: string): Warning {
  return make({
    code: "VENT_OUT_OF_BOUNDS",
    severity: "error",
    message: `Vent "${ventId}": ${field} ${detail}.`,
    location: { kind: "vent", id: ventId, field },
  });
}

/** A wall vent's span does not reach the second compartment's height range (Req 4.10). Elevations are absolute, m. */
export function ventNoVerticalOverlap(
  ventId: string,
  fromId: string,
  toId: string,
  ventSillM: number,
  ventSoffitM: number,
  toFloorM: number,
  toCeilingM: number,
): Warning {
  return make({
    code: "VENT_NO_VERTICAL_OVERLAP",
    severity: "error",
    message: `Vent "${ventId}" between "${fromId}" and "${toId}" spans ${ventSillM} to ${ventSoffitM} m, but "${toId}" spans ${toFloorM} to ${toCeilingM} m. The vent does not reach "${toId}", so no gas can flow through it. The simulation was not started.`,
    location: { kind: "vent", id: ventId },
    source: "Req 4.10",
  });
}

/** Open-fraction table violates a rule (Req 4.4, 5.4). */
export function openTableInvalid(ventId: string, rule: string, entry?: number): Warning {
  const where = entry !== undefined ? ` (entry ${entry})` : "";
  const location: WarningLocation =
    entry !== undefined
      ? { kind: "vent", id: ventId, field: "open", row: entry }
      : { kind: "vent", id: ventId, field: "open" };
  return make({
    code: "OPEN_TABLE_INVALID",
    severity: "error",
    message: `Vent "${ventId}": the open-fraction table${where} ${rule}.`,
    location,
  });
}

/** Leakage area outside (0, 100] m2 (Req 4.7). */
export function leakageAreaInvalid(ventId: string, areaM2: number): Warning {
  return make({
    code: "LEAKAGE_AREA_INVALID",
    severity: "error",
    message: `Leakage "${ventId}" has an area of ${areaM2} m2. It must be above 0 and at most 100 m2.`,
    location: { kind: "vent", id: ventId, field: "areaM2" },
    source: "Tech Ref 4.4",
  });
}

/** A fire names a compartment that does not exist. */
export function fireCompartmentMissing(fireId: string, compartmentId: string): Warning {
  return make({
    code: "FIRE_COMPARTMENT_MISSING",
    severity: "error",
    message: `Fire "${fireId}" is placed in compartment "${compartmentId}", which does not exist.`,
    location: { kind: "fire", id: fireId },
  });
}

/** A fire position lies outside its compartment (Req 1.8, 6.6). */
export function fireOutsideCompartment(fireId: string, compartmentId: string): Warning {
  return make({
    code: "FIRE_OUTSIDE_COMPARTMENT",
    severity: "error",
    message: `Fire "${fireId}" is positioned outside compartment "${compartmentId}".`,
    location: { kind: "fire", id: fireId, field: "position" },
  });
}

/** A fire radiative fraction or fuel value is out of range (Req 6.6). */
export function fireValueInvalid(
  code: "FIRE_RADIATIVE_FRACTION" | "FIRE_FUEL_INVALID",
  fireId: string,
  field: string,
  requirement: string,
): Warning {
  return make({
    code,
    severity: "error",
    message: `Fire "${fireId}": ${field} must be ${requirement}.`,
    location: { kind: "fire", id: fireId, field },
  });
}

/** An HRR table row or column is invalid (Req 1.7, 6.2). `row` is 0-based; null when the table as a whole is wrong. */
export function hrrTableInvalid(
  fireId: string,
  rule: string,
  row: number | null,
  column?: string,
): Warning {
  const where =
    row === null ? "" : ` row ${row}${column !== undefined ? `, column ${column}` : ""}`;
  const location: WarningLocation = { kind: "fire", id: fireId, field: "table" };
  if (row !== null) location.row = row;
  if (column !== undefined) location.column = column;
  return make({
    code: "HRR_TABLE_INVALID",
    severity: "error",
    message: `Fire "${fireId}", heat release table${where}: ${rule}.`,
    location,
  });
}

/** Duration is not above zero. */
export function durationInvalid(durationS: number): Warning {
  return make({
    code: "DURATION_INVALID",
    severity: "error",
    message: `The duration is ${durationS} s. It must be a finite number above 0 s.`,
    location: { kind: "field", field: "durationS" },
  });
}

/** Print interval is zero, negative or longer than the duration (Req 10.3). */
export function printIntervalInvalid(printIntervalS: number, durationS: number): Warning {
  return make({
    code: "PRINT_INTERVAL_INVALID",
    severity: "error",
    message: `The print interval is ${printIntervalS} s. It must be above 0 s and no longer than the duration (${durationS} s).`,
    location: { kind: "field", field: "printIntervalS" },
  });
}

/** Compartments joined by a ceiling or floor vent do not stack (Req 2.8). The run continues. */
export function stackingMismatch(lowerId: string, upperId: string, gapM: number): Warning {
  return make({
    code: "STACKING_MISMATCH",
    severity: "warning",
    message: `Compartments "${lowerId}" and "${upperId}" are joined by a ceiling or floor vent, but their heights and floor elevations differ by ${gapM} m. The model uses the geometry as given.`,
    location: { kind: "compartment", id: lowerId },
  });
}

/** A sprinkler, detector, suppression, target or HVAC item is ignored (Req 5.9, 6.12). The run continues. */
export function unsupportedItem(kind: string, id: string): Warning {
  const what = kind === "hvac" ? "Fans, ducts and HVAC are not supported" : `The ${kind} item is not supported`;
  return make({
    code: "UNSUPPORTED_ITEM",
    severity: "warning",
    message: `${what}. "${id}" was ignored and the run continued without it.`,
    location: { kind: "scenario", id },
  });
}

/** Heat of combustion outside the range the model clamps to. The run continues (design: Fire modules step 3). */
export function heatOfCombustionRange(fireId: string, valueJPerKg: number, minJPerKg: number, maxJPerKg: number): Warning {
  return make({
    code: "HEAT_OF_COMBUSTION_RANGE",
    severity: "warning",
    message: `Fire "${fireId}" has a heat of combustion of ${valueJPerKg} J/kg. For rows that release heat, the model limits it to ${minJPerKg} to ${maxJPerKg} J/kg.`,
    location: { kind: "fire", id: fireId, field: "fuel.heatOfCombustionJPerKg" },
    source: "CFAST 7.7.7 source, input_namelist.f90, set_heat_of_combustion",
  });
}

/** Stair, shaft or corridor limit (Req 5.7, 5.8). Attached to values through Result.flags. */
export function stairOrShaftLimit(target: { kind: "compartment" | "vent"; id: string }): Warning {
  return make({
    code: "STAIR_OR_SHAFT_LIMIT",
    severity: "warning",
    message:
      "Results here are less reliable. The model's equations were developed for rooms, not for stairs, vertical shafts or long corridors.",
    location: { kind: target.kind, id: target.id },
    source: "Tech Ref 1.5",
  });
}

/** Step size fell below the minimum (Req 9.6). The run stopped; earlier samples are kept. */
export function solverStepTooSmall(timeS: number): Warning {
  return make({
    code: "SOLVER_STEP_TOO_SMALL",
    severity: "error",
    message: `The solver could not continue at ${timeS} s of simulated time and the run stopped. Results up to the last recorded sample are kept.`,
    location: { kind: "scenario" },
    timeS,
  });
}

/** NaN or infinity appeared in the state or a derived value (Req 11.5). */
export function nonFiniteState(quantity: string, compartmentId: string | null, timeS: number): Warning {
  const where = compartmentId !== null ? ` in compartment "${compartmentId}"` : "";
  return make({
    code: "NON_FINITE_STATE",
    severity: "error",
    message: `${quantity}${where} became not a finite number at ${timeS} s and the run stopped. Results up to the previous sample are kept.`,
    location:
      compartmentId !== null ? { kind: "compartment", id: compartmentId, field: quantity } : { kind: "scenario", field: quantity },
    timeS,
  });
}

/** A species mass fraction left 0 to 1 (Req 8.8). */
export function speciesOutOfRange(
  compartmentId: string,
  layer: "upper" | "lower",
  species: string,
  timeS: number,
): Warning {
  return make({
    code: "SPECIES_OUT_OF_RANGE",
    severity: "error",
    message: `The ${species} mass fraction in the ${layer} layer of compartment "${compartmentId}" left the range 0 to 1 at ${timeS} s and the run stopped.`,
    location: { kind: "compartment", id: compartmentId, field: `${layer}.${species}` },
    timeS,
  });
}

/** An output value could not be computed; the last valid value was kept (Req 14.10). */
export function uncomputableOutput(variable: string, timeS: number): Warning {
  return make({
    code: "UNCOMPUTABLE_OUTPUT",
    severity: "warning",
    message: `${variable} could not be computed at ${timeS} s. The last valid value is shown instead.`,
    location: { kind: "field", field: variable },
    timeS,
  });
}

/** Unexpected exception inside the model (Req 11.6). */
export function internalError(detail: string): Warning {
  return make({
    code: "INTERNAL_ERROR",
    severity: "error",
    message: `The model stopped because of an internal error: ${detail}. Results up to the last recorded sample are kept.`,
    location: { kind: "scenario" },
  });
}

/** The Web Worker reported an error (Req 10.12). */
export function workerError(detail: string): Warning {
  return make({
    code: "WORKER_ERROR",
    severity: "error",
    message: `The background worker that runs the simulation failed: ${detail}.`,
    location: { kind: "scenario" },
  });
}

/** A line of CFAST input could not be read. `line` is 1-based. */
export function cfastParse(line: number, detail: string): Warning {
  return make({
    code: "CFAST_PARSE",
    severity: "warning",
    message: `Line ${line}: ${detail}.`,
    location: { kind: "scenario", field: `line ${line}` },
  });
}

/** A CFAST feature this model does not support (Req 15.3). */
export function cfastUnsupported(feature: string, line: number): Warning {
  return make({
    code: "CFAST_UNSUPPORTED",
    severity: "warning",
    message: `Line ${line}: ${feature} is not supported by this model.`,
    location: { kind: "scenario", field: `line ${line}` },
  });
}

/** CFAST input text is larger than the reader accepts. */
export function cfastInputTooLarge(sizeBytes: number, limitBytes: number): Warning {
  return make({
    code: "CFAST_INPUT_TOO_LARGE",
    severity: "error",
    message: `The input is ${sizeBytes} bytes. The reader accepts at most ${limitBytes} bytes.`,
    location: { kind: "scenario" },
  });
}
