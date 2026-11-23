// Burning items a scenario can start from. Each is a t-squared design fire with a peak and a burnout.
// Peaks marked "measured" come from the NIST Fire Calorimetry Database (Design Fires - Residential and Office Items);
// the others are design estimates and the app says so.
import type { Fire, HrrRow } from "../fire";

export interface FireItem {
  id: string;
  label: string;
  peakKW: number;
  growth: "slow" | "medium" | "fast" | "ultrafast";
  holdS: number; // time at peak before decay
  decayS: number;
  source: "measured" | "estimate";
  fuel: Fire["fuel"];
  sootYield: number;
  coYield: number;
  heightM: number;
  areaM2: number;
}

const POLYURETHANE: Fire["fuel"] = { c: 6.3, h: 7.1, o: 2.1, n: 1, cl: 0, heatOfCombustionJPerKg: 2.6e7 };
const WOOD: Fire["fuel"] = { c: 1, h: 1.7, o: 0.72, n: 0.001, cl: 0, heatOfCombustionJPerKg: 1.7e7 };
const OIL: Fire["fuel"] = { c: 18, h: 34, o: 2, n: 0, cl: 0, heatOfCombustionJPerKg: 3.7e7 };
const MIXED: Fire["fuel"] = { c: 1, h: 1.5, o: 0.4, n: 0, cl: 0, heatOfCombustionJPerKg: 2.0e7 };

export const FIRE_ITEMS: FireItem[] = [
  { id: "upholstered_chair", label: "Upholstered chair", peakKW: 650, growth: "fast", holdS: 120, decayS: 300, source: "estimate", fuel: POLYURETHANE, sootYield: 0.08, coYield: 0.02, heightM: 0.5, areaM2: 0.5 },
  { id: "foam_mattress", label: "Foam mattress", peakKW: 900, growth: "fast", holdS: 120, decayS: 300, source: "estimate", fuel: POLYURETHANE, sootYield: 0.1, coYield: 0.02, heightM: 0.3, areaM2: 2 },
  { id: "sofa", label: "Sofa", peakKW: 2000, growth: "fast", holdS: 180, decayS: 400, source: "estimate", fuel: POLYURETHANE, sootYield: 0.08, coYield: 0.02, heightM: 0.5, areaM2: 2 },
  { id: "acoustic_foam", label: "Acoustic foam on walls", peakKW: 1500, growth: "ultrafast", holdS: 120, decayS: 240, source: "estimate", fuel: POLYURETHANE, sootYield: 0.12, coYield: 0.03, heightM: 1.5, areaM2: 4 },
  { id: "deep_fryer", label: "Deep fryer / cooking oil", peakKW: 500, growth: "ultrafast", holdS: 300, decayS: 300, source: "estimate", fuel: OIL, sootYield: 0.04, coYield: 0.01, heightM: 0.9, areaM2: 0.3 },
  { id: "bookcase", label: "Bookcase / shelving", peakKW: 1000, growth: "medium", holdS: 300, decayS: 400, source: "estimate", fuel: WOOD, sootYield: 0.015, coYield: 0.004, heightM: 0.3, areaM2: 0.8 },
  { id: "trash_bin", label: "Waste bin", peakKW: 150, growth: "medium", holdS: 200, decayS: 200, source: "estimate", fuel: MIXED, sootYield: 0.05, coYield: 0.02, heightM: 0.5, areaM2: 0.2 },
  { id: "stored_boxes", label: "Stored cardboard boxes", peakKW: 1200, growth: "fast", holdS: 240, decayS: 400, source: "estimate", fuel: WOOD, sootYield: 0.03, coYield: 0.01, heightM: 0.2, areaM2: 2 },
];

const ALPHA_KW_PER_S2 = { slow: 0.00293, medium: 0.01172, fast: 0.0469, ultrafast: 0.1876 } as const;

export function fireItem(id: string): FireItem {
  return FIRE_ITEMS.find((f) => f.id === id) ?? FIRE_ITEMS[0]!;
}

/** Heat release table for an item: t-squared growth to the peak, a plateau, then a linear decay to zero. */
export function hrrTable(item: FireItem): HrrRow[] {
  const alpha = ALPHA_KW_PER_S2[item.growth];
  const tPeak = Math.sqrt(item.peakKW / alpha);
  const rows: HrrRow[] = [];
  const push = (t: number, kw: number) =>
    rows.push({ timeS: Math.round(t * 10) / 10, hrrW: kw * 1000, heightM: item.heightM, areaM2: item.areaM2, coYield: item.coYield, sootYield: item.sootYield });
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const t = (tPeak * i) / n;
    push(t, alpha * t * t);
  }
  push(tPeak + item.holdS, item.peakKW);
  push(tPeak + item.holdS + item.decayS, 0);
  push(tPeak + item.holdS + item.decayS + 10, 0);
  return rows;
}
