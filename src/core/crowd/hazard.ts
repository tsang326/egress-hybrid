// Conditions a person meets in a room, read from the fire model result, and the dose they build up.
// Heat: ISO 13571 convective heat, time to incapacitation t (min) = 5e7 * T^-3.4 with T in degrees C.
// CO: ISO 13571 simplified asphyxiant dose, FED = sum(ppm * dt_min) / 35000.
// Smoke slows walking (after Jin's experiments); the factors here are estimates.
import type { Result } from "../fire";

export const HEAD_HEIGHT_M = 1.6;
const BLEND_M = 0.3;

export interface Exposure {
  tempC: number;
  visibilityM: number;
  coPpm: number;
  inSmokeLayer: boolean;
}

const CO_MASS_TO_PPM = 1.035e6; // (M_air / M_CO) * 1e6

export class HazardField {
  private readonly idx = new Map<string, number>();
  constructor(private readonly r: Result | null) {
    r?.compartments.forEach((c, i) => this.idx.set(c.id, i));
  }

  at(roomId: string, tS: number): Exposure {
    const r = this.r;
    const i = this.idx.get(roomId);
    if (!r || i === undefined || r.timesS.length === 0) return { tempC: 20, visibilityM: Infinity, coPpm: 0, inSmokeLayer: false };
    const c = r.compartments[i]!;
    const ts = r.timesS;
    let k = Math.min(ts.length - 1, Math.max(0, Math.floor((tS - ts[0]!) / Math.max(1e-9, (ts[1] ?? 1) - ts[0]!))));
    while (k > 0 && ts[k]! > tS) k--;
    while (k < ts.length - 1 && ts[k + 1]! <= tS) k++;
    const k1 = Math.min(ts.length - 1, k + 1);
    const f = k1 === k ? 0 : Math.max(0, Math.min(1, (tS - ts[k]!) / (ts[k1]! - ts[k]!)));
    const lerp = (a: Float64Array) => a[k]! + (a[k1]! - a[k]!) * f;
    // A real smoke layer has no sharp edge, and a two-zone interface near head height would flip a person between the
    // hot layer and clean air from one step to the next. Blend the two layers over BLEND_M either side of head height.
    const z = lerp(c.interfaceHeightM);
    const w = Math.max(0, Math.min(1, (HEAD_HEIGHT_M + BLEND_M - z) / (2 * BLEND_M))); // share of the upper layer
    const visAt = (l: typeof c.upper) => {
      const a = l.visibilityM[k]!, b = l.visibilityM[k1]!;
      return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Math.min(a, b);
    };
    const temp = w * lerp(c.upperTempK) + (1 - w) * lerp(c.lowerTempK);
    const odU = 1 / Math.max(1e-6, visAt(c.upper)), odL = 1 / Math.max(1e-6, visAt(c.lower)); // obscuration adds like optical density
    const od = w * odU + (1 - w) * odL;
    const visibilityM = od < 1e-6 ? Infinity : 1 / od;
    const co = w * lerp(c.upper.co) + (1 - w) * lerp(c.lower.co);
    const inUpper = w >= 0.5;
    return { tempC: temp - 273.15, visibilityM, coPpm: Math.max(0, co * CO_MASS_TO_PPM), inSmokeLayer: inUpper };
  }
}

export function heatDosePerS(tempC: number): number {
  if (tempC <= 40) return 0;
  const tMin = 5e7 * Math.pow(tempC, -3.4);
  return 1 / (tMin * 60);
}

export function coDosePerS(ppm: number): number {
  return ppm / 35000 / 60;
}

export function smokeSpeedFactor(visibilityM: number): number {
  if (visibilityM >= 10) return 1;
  if (visibilityM >= 3) return 0.6 + (0.4 * (visibilityM - 3)) / 7;
  return 0.4;
}

export type SmokeLevel = "clear" | "light" | "thick";
export function smokeLevel(e: Exposure): SmokeLevel {
  if (e.visibilityM < 3) return "thick";
  if (e.visibilityM < 10) return "light";
  return "clear";
}
