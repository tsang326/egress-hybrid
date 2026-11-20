import type { PersonaKind } from "../plan/scenario";
import type { SmokeLevel } from "./hazard";

export type Action =
  | { kind: "go_exit"; doorId: string }
  | { kind: "follow"; leaderId: number }
  | { kind: "shelter" }
  | { kind: "guide" }
  | { kind: "wait"; seconds: number }
  | { kind: "go_room"; roomId: string };

export interface DecisionOption {
  id: string; // "A", "B", ...
  action: Action;
  label: string; // what the person would do, in plain words
  etaS?: number; // estimated time to reach the exit
  notes: string[]; // what the person can tell about this option
}

export type Trigger = "alarm" | "blocked" | "smoke" | "smoke_ahead" | "guided" | "arrived" | "waited";

export interface DecisionRequest {
  agentId: number;
  name: string;
  persona: PersonaKind;
  personaText: string;
  trigger: Trigger;
  triggerText: string;
  timeS: number;
  roomId: string;
  roomName: string;
  smokeHere: SmokeLevel;
  tempC: number;
  peopleHere: number;
  observations: string[];
  options: DecisionOption[];
}

export type DecisionSource = "standard" | "on_device" | "cloud" | "fallback";

export interface Decision {
  agentId: number;
  optionId: string;
  reason: string;
  source: DecisionSource;
}

export interface Policy {
  readonly name: string;
  decide(requests: DecisionRequest[]): Promise<Decision[]>;
}

export type Outcome = "out" | "incapacitated" | "sheltering" | "inside";

export interface DecisionLogEntry {
  timeS: number;
  trigger: Trigger;
  roomName: string;
  chosen: string;
  reason: string;
  source: DecisionSource;
  optionCount: number;
}

export interface AgentSummary {
  id: number;
  name: string;
  persona: PersonaKind;
  startRoom: string;
  outcome: Outcome;
  timeS: number | null; // time out, or time incapacitated
  exitDoor: string | null;
  peakHeatDose: number;
  peakCoDose: number;
  cause: "heat" | "co" | null;
  /** Seconds spent in thick smoke (visibility under 3 m) or heat of 60 °C or more at head height. */
  smokeS: number;
  worstTempC: number;
  worstVisM: number; // capped at 30 m
  worstRoom: string | null; // room id where they met the hottest air
  decisions: DecisionLogEntry[];
}

export interface DoorStat {
  doorId: string;
  passed: number;
  maxQueue: number;
  firstUseS: number | null;
  lastUseS: number | null;
}

export const STATE = { premove: 0, moving: 1, queue: 2, transit: 3, out: 4, incapacitated: 5, sheltering: 6, busy: 7 } as const;

export interface CrowdResult {
  policy: string;
  frameDtS: number;
  frames: Float32Array[]; // per frame: [x, y, floor, state] for each agent
  agents: AgentSummary[];
  doors: DoorStat[];
  endTimeS: number;
  aiCalls: number;
  decisionsBySource: Record<DecisionSource, number>;
}
