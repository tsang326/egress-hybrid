// Steckler digitiser (spec fire-zone, task 15.1, Requirements 13.10 and 12.9).
//
// Run by hand, never by the app or by `npm test`:
//
//   node tools/steckler/digitise.ts [path/to/CFAST_Validation_Guide.pdf] [--out file]
//
// The CFAST Validation Guide (Appendix C.17) shows the Steckler results only as plots. This script renders each
// plot page to SVG with poppler's `pdftocairo -svg`, reads the vector drawing as data (axis ticks, marker circles,
// the dashed CFAST line) and converts it to °C and m with the plot's own axis ticks. The result is written to
// validation/harness/published/steckler.ts and is labelled "digitised, not printed in the Guide".
//
// The SVG is parsed with a small scanner written for this file. Nothing in the SVG is evaluated.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

export const SCRIPT_PATH = 'tools/steckler/digitise.ts';
export const DEFAULT_PDF = 'docs/refs/CFAST_Validation_Guide.pdf';
export const DEFAULT_OUT = 'validation/harness/published/steckler.ts';

/** The nine Steckler tests of design.md "Published Steckler values". Page numbers: Validation Guide Appendix C.17. */
export interface TestPage {
  readonly test: number;
  readonly pdfPage: number;
  readonly printedPage: number;
}
export const STECKLER_TESTS: readonly TestPage[] = [
  { test: 10, pdfPage: 359, printedPage: 335 },
  { test: 12, pdfPage: 359, printedPage: 335 },
  { test: 14, pdfPage: 359, printedPage: 335 },
  { test: 17, pdfPage: 360, printedPage: 336 },
  { test: 114, pdfPage: 361, printedPage: 337 },
  { test: 212, pdfPage: 361, printedPage: 337 },
  { test: 116, pdfPage: 362, printedPage: 338 },
  { test: 514, pdfPage: 363, printedPage: 339 },
  { test: 517, pdfPage: 363, printedPage: 339 },
];

export const EXPECTED_MEASURED_POINTS = 19; // 19 thermocouples (design.md, Published Steckler values)
export const MIN_TICKS_PER_AXIS = 3;
export const MAX_FIT_RESIDUAL_FRACTION = 0.005; // 0.5 % of the axis span (task 15.1)
export const TEMPERATURE_STEP_C = 0.1;
export const HEIGHT_STEP_M = 0.01;

// Geometry heuristics for the Guide's plots, in SVG user units (1 unit = 1 pt of the PDF page).
const MAX_TICK_LENGTH = 4; // tick marks in the Guide are 3.5 plot units = 1.7 pt
const MARKER_MIN_SIZE = 1;
const MARKER_MAX_SIZE = 4; // measured markers are circles of about 2.4 pt
const MARKER_ASPECT_TOLERANCE = 0.1;
const DIGIT_ADVANCE = 3.911; // advance of one digit of the tick-label font, used only to find a label's centre
const LABEL_MATCH_TOLERANCE = 4; // pt; ticks are at least 20 pt apart
const X_LABEL_BELOW_MIN = 2; // x-axis label baseline lies this far or more below the axis
const X_LABEL_BELOW_MAX = 14;
const Y_LABEL_BASELINE_OFFSET = 2.67; // y-axis label baseline lies this far below the tick (half the digit height)
const MIN_TITLE_GLYPHS = 25;

/**
 * Digit glyph identities. Cairo numbers glyphs per plot, so a glyph is identified by a hash of its outline. These
 * hashes were taken from the Guide's tick labels (0, 50 .. 300; 0.0, 0.4 .. 2.0) and plot titles on PDF page 359
 * (Test 710 supplies the 7). The digit 9 does not occur in the plots read here. A glyph that is not in the table
 * decodes to '?', so a label that contains one is not used as a tick.
 */
const GLYPH_HASHES: Readonly<Record<string, string>> = {
  '5b90b740600b': '0',
  '298b8276c123': '1',
  '6da966b6d92f': '2',
  '2d2e479bd889': '3',
  ba9b1203d719: '4',
  '0402dfc1da7c': '5',
  '043849f79f4b': '6',
  '75c9b5b01ad2': '7',
  '23a0067bb388': '8',
  '8f480ee8e354': '.',
};

// ---------------------------------------------------------------------------------------------------------------
// SVG scanner (data only)
// ---------------------------------------------------------------------------------------------------------------

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface PathItem {
  readonly kind: 'path';
  readonly attrs: Readonly<Record<string, string>>;
  /** Path points (end points and control points) in page units, or null when the path uses unsupported commands. */
  readonly points: readonly Pt[] | null;
}

export interface GlyphUse {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface TextItem {
  readonly kind: 'text';
  readonly glyphs: readonly GlyphUse[];
  /** Decoded text; '?' for glyphs outside the digit table, ' ' for blank glyphs. */
  readonly text: string;
}

export type SceneItem = PathItem | TextItem;

export interface Scene {
  readonly items: readonly SceneItem[];
}

const TAG_RE = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g;
const ATTR_RE = /([\w:-]+)="([^"]*)"/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) out[name] = value;
  }
  return out;
}

export function parseMatrix(s: string | undefined): Matrix | null {
  if (s === undefined) return IDENTITY;
  const m = /^\s*matrix\(([^)]*)\)\s*$/.exec(s);
  if (m === null || m[1] === undefined) return null;
  const v = m[1].split(/[\s,]+/).filter((t) => t !== '').map(Number);
  if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) return null;
  return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0, v[4] ?? 0, v[5] ?? 0];
}

export function applyMatrix(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * Reads the absolute commands M, L, C and Z that cairo writes. Returns every coordinate pair (end points and control
 * points) or null for anything else (relative commands, arcs, junk numbers).
 */
export function parsePathPoints(d: string): Pt[] | null {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (tokens === null) return [];
  const pts: Pt[] = [];
  let cmd = '';
  let nums: number[] = [];
  const perCommand: Record<string, number> = { M: 2, L: 2, C: 6 };
  const flush = (): boolean => {
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i] ?? NaN, y: nums[i + 1] ?? NaN });
    const need = perCommand[cmd];
    return cmd === 'Z' ? nums.length === 0 : need !== undefined && nums.length % need === 0 && nums.length > 0;
  };
  for (const tok of tokens) {
    if (/^[A-Za-z]$/.test(tok)) {
      if (cmd !== '' && !flush()) return null;
      if (tok !== 'M' && tok !== 'L' && tok !== 'C' && tok !== 'Z') return null;
      cmd = tok;
      nums = [];
    } else {
      nums.push(Number(tok));
    }
  }
  if (cmd !== '' && !flush()) return null;
  return pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ? null : pts;
}

export function hashGlyph(d: string): string {
  return createHash('sha1').update(d.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** Scans the SVG text into path items and glyph-text items, in document order. Glyph and clip definitions are skipped. */
export function parseSvg(svg: string, glyphHashes: Readonly<Record<string, string>> = GLYPH_HASHES): Scene {
  const glyphChar = new Map<string, string>();
  const items: SceneItem[] = [];
  let defsDepth = 0;
  let currentGlyph: string | null = null;
  let pendingUses: GlyphUse[] = [];

  const flushText = (): void => {
    if (pendingUses.length === 0) return;
    const text = pendingUses.map((u) => glyphChar.get(u.id) ?? '?').join('');
    items.push({ kind: 'text', glyphs: pendingUses, text });
    pendingUses = [];
  };

  for (const m of svg.matchAll(TAG_RE)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    const attrs = closing ? {} : parseAttrs(m[3] ?? '');
    const selfClosing = m[4] === '/';

    if (name === 'defs') {
      if (closing) defsDepth = Math.max(0, defsDepth - 1);
      else if (!selfClosing) defsDepth += 1;
      continue;
    }
    if (defsDepth > 0) {
      if (name === 'g' && closing) currentGlyph = null;
      if (name === 'g' && !closing && attrs.id?.startsWith('glyph-') === true) {
        currentGlyph = attrs.id;
        glyphChar.set(currentGlyph, ' '); // a glyph without outline is a blank
      }
      if (name === 'path' && currentGlyph !== null && attrs.d !== undefined && attrs.d.trim() !== '') {
        glyphChar.set(currentGlyph, glyphHashes[hashGlyph(attrs.d)] ?? '?');
      }
      continue;
    }
    if (name === 'use' && !closing) {
      const href = attrs['xlink:href'] ?? attrs.href ?? '';
      pendingUses.push({ id: href.replace(/^#/, ''), x: Number(attrs.x ?? NaN), y: Number(attrs.y ?? NaN) });
      continue;
    }
    flushText();
    if (name === 'path' && !closing && attrs.d !== undefined) {
      const matrix = parseMatrix(attrs.transform);
      const raw = matrix === null ? null : parsePathPoints(attrs.d);
      const points = raw === null || matrix === null ? null : raw.map((p) => applyMatrix(matrix, p));
      items.push({ kind: 'path', attrs, points });
    }
  }
  flushText();
  return { items };
}

// ---------------------------------------------------------------------------------------------------------------
// Axis fit
// ---------------------------------------------------------------------------------------------------------------

export interface Tick {
  /** Position of the tick on the page (x for the horizontal axis, y for the vertical axis). */
  readonly coord: number;
  /** The value printed next to the tick. */
  readonly value: number;
}

export interface AxisFit {
  readonly slope: number; // value per page unit
  readonly intercept: number;
  readonly ticks: number;
  /** Largest distance between a tick's printed value and the fitted value. */
  readonly maxResidual: number;
  /** Largest printed value minus smallest printed value. */
  readonly span: number;
  readonly residualFraction: number;
  readonly convert: (coord: number) => number;
}

/** Least-squares line value = slope · coord + intercept through the labelled ticks. Null for fewer than 2 distinct ticks. */
export function fitAxis(ticks: readonly Tick[]): AxisFit | null {
  const n = ticks.length;
  if (n < 2) return null;
  const mc = ticks.reduce((s, t) => s + t.coord, 0) / n;
  const mv = ticks.reduce((s, t) => s + t.value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const t of ticks) {
    sxx += (t.coord - mc) ** 2;
    sxy += (t.coord - mc) * (t.value - mv);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = mv - slope * mc;
  const values = ticks.map((t) => t.value);
  const span = Math.max(...values) - Math.min(...values);
  const maxResidual = Math.max(...ticks.map((t) => Math.abs(slope * t.coord + intercept - t.value)));
  return {
    slope,
    intercept,
    ticks: n,
    maxResidual,
    span,
    residualFraction: span > 0 ? maxResidual / span : Infinity,
    convert: (coord: number) => slope * coord + intercept,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Plot analysis
// ---------------------------------------------------------------------------------------------------------------

export interface PlotReading {
  /** Test number read from the plot title ("... Steckler Test 10"), or null. */
  readonly test: number | null;
  readonly title: string | null;
  readonly xTicks: number;
  readonly yTicks: number;
  readonly xFit: AxisFit | null;
  readonly yFit: AxisFit | null;
  readonly measuredCount: number;
  /** Measured point with the highest temperature, in °C and m, unrounded. */
  readonly measuredMax: { readonly tempC: number; readonly heightM: number } | null;
  /** Dashed CFAST line: temperature and the height of its lower end, unrounded. */
  readonly cfast: { readonly tempC: number; readonly layerHeightM: number } | null;
  /** Self-check failures. Empty when the reading can be used. */
  readonly problems: readonly string[];
}

function isWhiteFill(attrs: Readonly<Record<string, string>>): boolean {
  return attrs.fill === 'rgb(100%, 100%, 100%)';
}

function bbox(points: readonly Pt[]): { x0: number; x1: number; y0: number; y1: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Splits the page items into one list per plot. A plot starts at a white filled, unstroked rectangle. */
export function splitPlots(scene: Scene): SceneItem[][] {
  const plots: SceneItem[][] = [];
  let prevWhiteBackground = false;
  for (const item of scene.items) {
    const whiteBackground = item.kind === 'path' && isWhiteFill(item.attrs) && item.attrs.stroke === undefined;
    if (whiteBackground && !prevWhiteBackground) plots.push([]);
    if (item.kind === 'path') prevWhiteBackground = whiteBackground;
    plots[plots.length - 1]?.push(item);
  }
  return plots;
}

interface Segment {
  readonly a: Pt;
  readonly b: Pt;
}

function shortSegments(items: readonly SceneItem[]): Segment[] {
  const out: Segment[] = [];
  for (const it of items) {
    if (it.kind !== 'path' || it.points === null || it.points.length !== 2) continue;
    if (it.attrs['stroke-width'] !== '0.5' || it.attrs['stroke-dasharray'] !== undefined) continue;
    const [a, b] = it.points;
    if (a === undefined || b === undefined) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= MAX_TICK_LENGTH) out.push({ a, b });
  }
  return out;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;

/** Reads one plot (a list of items from splitPlots). Never throws; self-check failures go to `problems`. */
export function analysePlot(items: readonly SceneItem[]): PlotReading {
  const problems: string[] = [];

  // Items after the legend box (white, stroked) belong to the legend and are not data.
  const legendAt = items.findIndex((it) => it.kind === 'path' && isWhiteFill(it.attrs) && it.attrs.stroke !== undefined);
  const body = legendAt < 0 ? items : items.slice(0, legendAt);

  // Title.
  let title: string | null = null;
  let test: number | null = null;
  for (const it of items) {
    if (it.kind !== 'text' || it.glyphs.length < MIN_TITLE_GLYPHS) continue;
    const m = /\s(\d+)$/.exec(it.text);
    if (m !== null && m[1] !== undefined && (title === null || it.text.length > title.length)) {
      title = it.text;
      test = Number(m[1]);
    }
  }
  if (test === null) problems.push('no plot title with a test number found');

  // Axis ticks: short strokes. Bottom ticks are vertical strokes at the lowest y; left ticks are horizontal strokes
  // at the lowest x.
  const segs = shortSegments(body);
  const vertical = segs.filter((s) => Math.abs(s.a.x - s.b.x) < 1e-3);
  const horizontal = segs.filter((s) => Math.abs(s.a.y - s.b.y) < 1e-3);
  const bottomY = Math.max(...vertical.map((s) => Math.max(s.a.y, s.b.y)));
  const leftX = Math.min(...horizontal.map((s) => Math.min(s.a.x, s.b.x)));
  const xTickPos = [
    ...new Set(vertical.filter((s) => Math.max(s.a.y, s.b.y) >= bottomY - 0.01).map((s) => round3(s.a.x))),
  ].sort((a, b) => a - b);
  const yTickPos = [
    ...new Set(horizontal.filter((s) => Math.min(s.a.x, s.b.x) <= leftX + 0.01).map((s) => round3(s.a.y))),
  ].sort((a, b) => a - b);

  // Tick labels.
  const xTicks = new Map<number, number>();
  const yTicks = new Map<number, number>();
  for (const it of body) {
    if (it.kind !== 'text' || !NUMBER_RE.test(it.text)) continue;
    const first = it.glyphs[0];
    const last = it.glyphs[it.glyphs.length - 1];
    if (first === undefined || last === undefined) continue;
    const value = Number(it.text);
    if (first.y > bottomY + X_LABEL_BELOW_MIN && first.y < bottomY + X_LABEL_BELOW_MAX) {
      const centre = (first.x + last.x + DIGIT_ADVANCE) / 2;
      const pos = nearest(xTickPos, centre);
      if (pos !== null && Math.abs(pos - centre) <= LABEL_MATCH_TOLERANCE) {
        if (xTicks.has(pos)) problems.push(`two labels for the horizontal tick at ${pos}`);
        xTicks.set(pos, value);
      }
    } else if (last.x < leftX) {
      const mid = first.y - Y_LABEL_BASELINE_OFFSET;
      const pos = nearest(yTickPos, mid);
      if (pos !== null && Math.abs(pos - mid) <= LABEL_MATCH_TOLERANCE / 2) {
        if (yTicks.has(pos)) problems.push(`two labels for the vertical tick at ${pos}`);
        yTicks.set(pos, value);
      }
    }
  }
  const xFit = fitAxis([...xTicks].map(([coord, value]) => ({ coord, value })));
  const yFit = fitAxis([...yTicks].map(([coord, value]) => ({ coord, value })));
  for (const [name, ticks, fit] of [
    ['horizontal', xTicks, xFit],
    ['vertical', yTicks, yFit],
  ] as const) {
    if (ticks.size < MIN_TICKS_PER_AXIS) {
      problems.push(`${name} axis has ${ticks.size} labelled ticks, need at least ${MIN_TICKS_PER_AXIS}`);
    } else if (fit === null || !(fit.residualFraction < MAX_FIT_RESIDUAL_FRACTION)) {
      problems.push(
        `${name} axis fit residual is ${fit === null ? 'undefined' : (fit.residualFraction * 100).toFixed(3) + ' % of the span'}, limit ${MAX_FIT_RESIDUAL_FRACTION * 100} %`,
      );
    }
  }

  // Measured markers: filled black circles before the legend.
  const markers: Pt[] = [];
  for (const it of body) {
    if (it.kind !== 'path' || it.points === null || it.points.length < 12) continue;
    if (it.attrs.fill !== 'rgb(0%, 0%, 0%)' || it.attrs['stroke-width'] !== '1') continue;
    const b = bbox(it.points);
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w < MARKER_MIN_SIZE || h < MARKER_MIN_SIZE || w > MARKER_MAX_SIZE || h > MARKER_MAX_SIZE) continue;
    if (Math.abs(w - h) > MARKER_ASPECT_TOLERANCE * Math.max(w, h)) continue;
    markers.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  }
  if (markers.length !== EXPECTED_MEASURED_POINTS) {
    problems.push(`found ${markers.length} measured points, expected ${EXPECTED_MEASURED_POINTS}`);
  }

  // CFAST line: one dashed vertical stroke before the legend.
  const dashed = body.filter(
    (it): it is PathItem =>
      it.kind === 'path' &&
      it.attrs['stroke-dasharray'] !== undefined &&
      it.points !== null &&
      it.points.length === 2 &&
      Math.abs((it.points[0]?.x ?? 0) - (it.points[1]?.x ?? 1)) < 1e-3,
  );
  if (dashed.length !== 1) problems.push(`found ${dashed.length} dashed CFAST lines, expected 1`);

  let measuredMax: PlotReading['measuredMax'] = null;
  let cfast: PlotReading['cfast'] = null;
  if (problems.length === 0 && xFit !== null && yFit !== null) {
    const pts = markers.map((p) => ({ tempC: xFit.convert(p.x), heightM: yFit.convert(p.y) }));
    measuredMax = pts.reduce((best, p) => (p.tempC > best.tempC ? p : best));
    const line = dashed[0]?.points;
    const p0 = line?.[0];
    const p1 = line?.[1];
    if (p0 !== undefined && p1 !== undefined) {
      cfast = {
        tempC: xFit.convert(p0.x),
        layerHeightM: Math.min(yFit.convert(p0.y), yFit.convert(p1.y)),
      };
    }
  }

  return {
    test,
    title,
    xTicks: xTicks.size,
    yTicks: yTicks.size,
    xFit,
    yFit,
    measuredCount: markers.length,
    measuredMax,
    cfast,
    problems,
  };
}

function nearest(sorted: readonly number[], v: number): number | null {
  let best: number | null = null;
  for (const p of sorted) if (best === null || Math.abs(p - v) < Math.abs(best - v)) best = p;
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

export interface SteckerRecord {
  readonly test: number;
  readonly quantity: string;
  readonly unit: string;
  readonly cfast: number;
  readonly measured: number;
  readonly cfastLayerHeightM: number;
  readonly measuredMaxHeightM: number;
  readonly pdfPage: number;
  readonly printedPage: number;
  readonly digitised: true;
}

export function roundTo(v: number, step: number): number {
  const r = Math.round(v / step) * step;
  const decimals = step < 0.1 ? 2 : 1;
  return Number((r === 0 ? 0 : r).toFixed(decimals));
}

export function toRecord(page: TestPage, reading: PlotReading): SteckerRecord | null {
  if (reading.measuredMax === null || reading.cfast === null) return null;
  return {
    test: page.test,
    quantity: 'upper-layer temperature (measured: maximum of the profile)',
    unit: '°C',
    cfast: roundTo(reading.cfast.tempC, TEMPERATURE_STEP_C),
    measured: roundTo(reading.measuredMax.tempC, TEMPERATURE_STEP_C),
    cfastLayerHeightM: roundTo(reading.cfast.layerHeightM, HEIGHT_STEP_M),
    measuredMaxHeightM: roundTo(reading.measuredMax.heightM, HEIGHT_STEP_M),
    pdfPage: page.pdfPage,
    printedPage: page.printedPage,
    digitised: true,
  };
}

export function renderModule(records: readonly SteckerRecord[], meta: { pdf: string; poppler: string }): string {
  const rows = records
    .map(
      (r) =>
        `  {\n` +
        `    test: ${r.test},\n` +
        `    quantity: ${JSON.stringify(r.quantity)},\n` +
        `    unit: ${JSON.stringify(r.unit)},\n` +
        `    cfast: ${r.cfast.toFixed(1)},\n` +
        `    measured: ${r.measured.toFixed(1)},\n` +
        `    cfastLayerHeightM: ${r.cfastLayerHeightM.toFixed(2)},\n` +
        `    measuredMaxHeightM: ${r.measuredMaxHeightM.toFixed(2)},\n` +
        `    pdfPage: ${r.pdfPage},\n` +
        `    printedPage: ${r.printedPage},\n` +
        `    digitised: true,\n` +
        `  },`,
    )
    .join('\n');
  return (
    `// GENERATED by ${SCRIPT_PATH}. Do not edit by hand.\n` +
    `//\n` +
    `// Source: ${meta.pdf} (CFAST Validation Guide, Appendix C.17), read with poppler ${meta.poppler}.\n` +
    `// These values are digitised, not printed in the Guide. They were read from the vector drawing of each plot\n` +
    `// (marker circle centres and the dashed CFAST line) and converted with the plot's own axis ticks.\n` +
    `// Reading uncertainty is about 0.1 °C and 0.01 m. Temperatures are absolute values in °C, not rises.\n` +
    `// They are not a pass criterion. The Guide does not state the time or averaging period of the profiles.\n` +
    `// cfast: CFAST upper-layer temperature. measured: highest temperature of the 19 measured points.\n` +
    `// cfastLayerHeightM: lower end of the dashed CFAST line. measuredMaxHeightM: height of the highest measured point.\n` +
    `\n` +
    `export interface PublishedSteckerRecord {\n` +
    `  readonly test: number;\n` +
    `  readonly quantity: string;\n` +
    `  readonly unit: string;\n` +
    `  readonly cfast: number;\n` +
    `  readonly measured: number;\n` +
    `  readonly cfastLayerHeightM: number;\n` +
    `  readonly measuredMaxHeightM: number;\n` +
    `  readonly pdfPage: number;\n` +
    `  readonly printedPage: number;\n` +
    `  readonly digitised: true;\n` +
    `}\n` +
    `\n` +
    `export const PUBLISHED_STECKLER: readonly PublishedSteckerRecord[] = [\n${rows}\n];\n`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`digitise: ${message}`);
  process.exit(1);
}

function main(argv: readonly string[]): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let pdfArg: string | null = null;
  let outArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outArg = argv[++i] ?? fail('--out needs a file name');
    else if (a !== undefined && !a.startsWith('--') && pdfArg === null) pdfArg = a;
    else fail(`unexpected argument ${String(a)}`);
  }
  const pdf = pdfArg === null ? resolve(repoRoot, DEFAULT_PDF) : resolve(pdfArg);
  const out = outArg === null ? resolve(repoRoot, DEFAULT_OUT) : resolve(outArg);

  const version = spawnSync('pdftocairo', ['-v'], { encoding: 'utf8' });
  if (version.error !== undefined) {
    fail(
      'pdftocairo was not found. Install poppler (macOS: `brew install poppler`; Debian/Ubuntu: `apt install poppler-utils`) ' +
        'and run again.',
    );
  }
  const poppler = /version\s+(\S+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? 'unknown';

  const tmp = mkdtempSync(join(tmpdir(), 'steckler-'));
  const records: SteckerRecord[] = [];
  let failed = false;
  try {
    const pages = [...new Set(STECKLER_TESTS.map((t) => t.pdfPage))].sort((a, b) => a - b);
    for (const pdfPage of pages) {
      const svgPath = join(tmp, `page-${pdfPage}.svg`);
      const run = spawnSync('pdftocairo', ['-svg', '-f', String(pdfPage), '-l', String(pdfPage), pdf, svgPath], {
        encoding: 'utf8',
      });
      if (run.status !== 0) fail(`pdftocairo failed on page ${pdfPage}: ${run.stderr.trim() || 'no message'}`);
      const plots = splitPlots(parseSvg(readFileSync(svgPath, 'utf8'))).map(analysePlot);
      for (const page of STECKLER_TESTS.filter((t) => t.pdfPage === pdfPage)) {
        const matches = plots.filter((p) => p.test === page.test);
        const reading = matches[0];
        if (matches.length !== 1 || reading === undefined) {
          console.error(`Test ${page.test} (PDF page ${pdfPage}): found ${matches.length} plots with this title, expected 1`);
          failed = true;
          continue;
        }
        if (reading.problems.length > 0) {
          for (const p of reading.problems) console.error(`Test ${page.test} (PDF page ${pdfPage}): ${p}`);
          failed = true;
          continue;
        }
        const record = toRecord(page, reading);
        if (record === null) {
          console.error(`Test ${page.test} (PDF page ${pdfPage}): no values read`);
          failed = true;
        } else records.push(record);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) fail('self-check failed, nothing written');

  const pdfLabel = relative(repoRoot, pdf).split(sep).join('/');
  const text = renderModule(records, { pdf: pdfLabel.startsWith('..') ? pdf : pdfLabel, poppler });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${relative(process.cwd(), out)} (${records.length} tests, poppler ${poppler})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
