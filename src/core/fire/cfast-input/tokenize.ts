// CFAST input scanner (Req 15.4). Hand-written, single pass, data only: nothing in the text is evaluated.
// It finds `&NAME ... /` groups, splits `KEY = value list` and reads quoted strings, numbers and
// .TRUE. / .FALSE. It never throws. Every Warning carries a 1-based line number.
//
// Input format: CFAST 7.7.7 User's Guide, "Input File" chapter (Fortran namelist style, `!` starts a comment).
import * as W from "../validate/warnings";
import type { Warning } from "../validate/warnings";

// Hard limits. They are this reader's own safety limits, not CFAST limits.
// The largest shipped case is under 9 kB. A 10,000-row HRR table (the Scenario limit, Req 1.1) needs 10,000 `&TABL` groups
// of about 60 characters each, so 2 MiB and 20,000 groups leave room for it.
export const MAX_INPUT_CHARS = 2 * 1024 * 1024;
export const MAX_GROUPS = 20_000;
export const MAX_TOKENS_PER_GROUP = 10_000;

export type RawValue = number | string | boolean;
export interface RawEntry {
  key: string; // upper case
  line: number;
  values: RawValue[];
}
export interface RawGroup {
  name: string; // upper case, without the `&`
  line: number; // line of the `&`
  entries: RawEntry[];
}
export interface TokenizeResult {
  groups: RawGroup[];
  warnings: Warning[];
  /** True when a hard limit stopped the scan, so the groups are incomplete. */
  limitHit: boolean;
  lineCount: number;
}

type TokenKind = "word" | "str" | "eq";
interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

// Fortran real literal, with D exponents allowed.
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const TRUE_WORDS = new Set([".TRUE.", ".T."]);
const FALSE_WORDS = new Set([".FALSE.", ".F."]);

export function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/** Same Warning, with the line recorded in its location (used for warnings built without a line). */
function atLine(w: Warning, line: number): Warning {
  return { ...w, location: { ...w.location, field: `line ${line}` } };
}

function isNameChar(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
}

function isWordEnd(ch: string): boolean {
  return (
    ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "," || ch === "=" || ch === "/" ||
    ch === "'" || ch === '"' || ch === "!" || ch === "&"
  );
}

/** Literal to value: number, boolean, or a bare word kept as a string. */
function wordValue(text: string): RawValue {
  if (NUMBER_RE.test(text)) {
    const x = Number(text.replace(/[dD]/, "e"));
    if (Number.isFinite(x)) return x;
    return text;
  }
  const up = text.toUpperCase();
  if (TRUE_WORDS.has(up)) return true;
  if (FALSE_WORDS.has(up)) return false;
  return text;
}

interface GroupScan {
  next: number;
  line: number;
  group: RawGroup | null;
  stop: boolean; // a hard limit was hit
}

function buildEntries(tokens: Token[], groupName: string, warnings: Warning[]): RawEntry[] {
  const entries: RawEntry[] = [];
  let current: RawEntry | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    const next = tokens[i + 1];
    if (t.kind === "word" && next !== undefined && next.kind === "eq") {
      current = { key: t.text.toUpperCase(), line: t.line, values: [] };
      entries.push(current);
      i += 1; // skip the "="
    } else if (t.kind === "eq") {
      warnings.push(W.cfastParse(t.line, `"=" without a keyword before it in &${groupName}`));
    } else if (current === null) {
      warnings.push(W.cfastParse(t.line, `value "${t.text}" without a keyword in &${groupName}`));
    } else {
      current.values.push(t.kind === "str" ? t.text : wordValue(t.text));
    }
  }
  const kept: RawEntry[] = [];
  for (const e of entries) {
    if (e.values.length === 0) warnings.push(W.cfastParse(e.line, `keyword ${e.key} in &${groupName} has no value`));
    else kept.push(e);
  }
  return kept;
}

function scanGroup(text: string, start: number, startLine: number, warnings: Warning[]): GroupScan {
  const n = text.length;
  let i = start + 1;
  let line = startLine;
  const nameStart = i;
  while (i < n && isNameChar(text[i] as string)) i += 1;
  const name = text.slice(nameStart, i).toUpperCase();
  if (name === "") {
    warnings.push(W.cfastParse(startLine, 'a "&" without a group name'));
    return { next: i, line, group: null, stop: false };
  }
  const tokens: Token[] = [];
  let closed = false;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === ",") {
      i += 1;
    } else if (ch === "!") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (ch === "/") {
      i += 1;
      closed = true;
      break;
    } else if (ch === "&") {
      break; // a new group starts before this one was closed
    } else {
      if (tokens.length >= MAX_TOKENS_PER_GROUP) {
        warnings.push(
          W.cfastParse(startLine, `group &${name} has more than ${MAX_TOKENS_PER_GROUP} tokens; reading stopped here`),
        );
        return { next: n, line, group: null, stop: true };
      }
      if (ch === "=") {
        tokens.push({ kind: "eq", text: "=", line });
        i += 1;
      } else if (ch === "'" || ch === '"') {
        const tokenLine = line;
        let s = "";
        let ok = false;
        i += 1;
        while (i < n) {
          const d = text[i] as string;
          if (d === ch) {
            if (text[i + 1] === ch) {
              s += ch; // doubled quote is one quote
              i += 2;
              continue;
            }
            i += 1;
            ok = true;
            break;
          }
          if (d === "\n") line += 1;
          s += d;
          i += 1;
        }
        if (!ok) {
          warnings.push(W.cfastParse(tokenLine, `quoted text in &${name} is not closed`));
          return { next: n, line, group: null, stop: false };
        }
        tokens.push({ kind: "str", text: s, line: tokenLine });
      } else {
        const from = i;
        while (i < n && !isWordEnd(text[i] as string)) i += 1;
        tokens.push({ kind: "word", text: text.slice(from, i), line });
      }
    }
  }
  if (!closed) {
    warnings.push(W.cfastParse(startLine, `group &${name} is not closed with "/"; the group was skipped`));
    return { next: i, line, group: null, stop: false };
  }
  return { next: i, line, group: { name, line: startLine, entries: buildEntries(tokens, name, warnings) }, stop: false };
}

/** Split CFAST input text into raw groups. Never throws. */
export function tokenize(text: string): TokenizeResult {
  const warnings: Warning[] = [];
  const groups: RawGroup[] = [];
  const lineCount = countLines(text);
  if (text.length > MAX_INPUT_CHARS) {
    // Characters stand in for bytes here; they are equal for ASCII input.
    warnings.push(atLine(W.cfastInputTooLarge(text.length, MAX_INPUT_CHARS), 1));
    return { groups, warnings, limitHit: true, lineCount };
  }
  let limitHit = false;
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (ch === "!") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (ch === "&") {
      if (groups.length >= MAX_GROUPS) {
        warnings.push(W.cfastParse(line, `more than ${MAX_GROUPS} groups; reading stopped here`));
        limitHit = true;
        break;
      }
      const r = scanGroup(text, i, line, warnings);
      i = r.next;
      line = r.line;
      if (r.group !== null) groups.push(r.group);
      if (r.stop) {
        limitHit = true;
        break;
      }
    } else {
      i += 1; // text outside a group is ignored, as CFAST does
    }
  }
  return { groups, warnings, limitHit, lineCount };
}
