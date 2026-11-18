// Sample plans drawn for this app. They are invented buildings, not copies of real premises.
import type { DrillScenario } from "./scenario";
import { OUTSIDE, type Plan } from "./types";

export const CAFE: Plan = {
  schemaVersion: 1,
  title: "Corner café",
  floorHeightM: 3.2,
  rooms: [
    { id: "dining", name: "Dining room", floor: 0, x: 0, y: 0, widthM: 10, depthM: 7, heightM: 3, kind: "room" },
    { id: "kitchen", name: "Kitchen", floor: 0, x: 10, y: 0, widthM: 6, depthM: 4, heightM: 3, kind: "room", staffOnly: true },
    { id: "store", name: "Store", floor: 0, x: 10, y: 4, widthM: 6, depthM: 3, heightM: 3, kind: "room", staffOnly: true },
    { id: "wc", name: "WC", floor: 0, x: 0, y: 7, widthM: 5, depthM: 4, heightM: 3, kind: "room" },
    { id: "corridor", name: "Rear corridor", floor: 0, x: 5, y: 7, widthM: 11, depthM: 4, heightM: 3, kind: "corridor" },
  ],
  doors: [
    { id: "D1", a: "dining", b: OUTSIDE, widthM: 1.2, x: 4, y: 0, state: "open", mainEntrance: true, exitSign: true },
    { id: "D2", a: "dining", b: "kitchen", widthM: 0.9, x: 10, y: 2, state: "open" },
    { id: "D3", a: "kitchen", b: "store", widthM: 0.9, x: 13, y: 4, state: "open" },
    { id: "D4", a: "kitchen", b: OUTSIDE, widthM: 1.0, x: 16, y: 2, state: "closed" },
    { id: "D5", a: "dining", b: "corridor", widthM: 0.9, x: 8, y: 7, state: "open" },
    { id: "D6", a: "corridor", b: "wc", widthM: 0.9, x: 5, y: 9, state: "open" },
    { id: "D7", a: "corridor", b: OUTSIDE, widthM: 0.9, x: 16, y: 9, state: "closed", exitSign: true },
  ],
};

export const CAFE_LUNCH: DrillScenario = {
  fire: { room: "kitchen", item: "deep_fryer" },
  lockedDoors: [],
  occupants: [
    { room: "dining", count: 40, kind: "customer" },
    { room: "dining", count: 4, kind: "elderly" },
    { room: "dining", count: 3, kind: "parent_with_child" },
    { room: "kitchen", count: 3, kind: "staff" },
    { room: "dining", count: 1, kind: "staff" },
    { room: "wc", count: 2, kind: "customer" },
  ],
  alarmDelayS: 30,
  durationS: 600,
  seed: 7,
};

export const OFFICE: Plan = {
  schemaVersion: 1,
  title: "Two-storey office",
  floorHeightM: 3.5,
  rooms: [
    { id: "reception", name: "Reception", floor: 0, x: 0, y: 0, widthM: 8, depthM: 6, heightM: 3, kind: "room" },
    { id: "office0", name: "Ground-floor office", floor: 0, x: 8, y: 0, widthM: 12, depthM: 8, heightM: 3, kind: "room" },
    { id: "corr0", name: "Ground corridor", floor: 0, x: 0, y: 6, widthM: 8, depthM: 2, heightM: 3, kind: "corridor" },
    { id: "stair0", name: "Stair (ground)", floor: 0, x: 0, y: 8, widthM: 3, depthM: 5, heightM: 3.5, kind: "stair" },
    { id: "office1", name: "First-floor office", floor: 1, x: 3, y: 0, widthM: 17, depthM: 8, heightM: 3, kind: "room" },
    { id: "meeting1", name: "Meeting room", floor: 1, x: 3, y: 8, widthM: 6, depthM: 5, heightM: 3, kind: "room" },
    { id: "stair1", name: "Stair (first)", floor: 1, x: 0, y: 8, widthM: 3, depthM: 5, heightM: 3.5, kind: "stair" },
    { id: "landing1", name: "First-floor landing", floor: 1, x: 0, y: 0, widthM: 3, depthM: 8, heightM: 3, kind: "corridor" },
  ],
  doors: [
    { id: "E1", a: "reception", b: OUTSIDE, widthM: 1.6, x: 4, y: 0, state: "open", mainEntrance: true, exitSign: true },
    { id: "G1", a: "reception", b: "office0", widthM: 1.0, x: 8, y: 3, state: "open" },
    { id: "G2", a: "reception", b: "corr0", widthM: 1.0, x: 4, y: 6, state: "open" },
    { id: "G3", a: "office0", b: "corr0", widthM: 0.9, x: 8, y: 7, state: "closed" },
    { id: "G4", a: "corr0", b: "stair0", widthM: 0.9, x: 1.5, y: 8, state: "closed" },
    { id: "E2", a: "stair0", b: OUTSIDE, widthM: 1.0, x: 0, y: 11, state: "closed", exitSign: true },
    { id: "S1", a: "stair0", b: "stair1", widthM: 1.0, x: 1.5, y: 10.5, state: "open", stair: { lengthM: 9 } },
    { id: "F1", a: "stair1", b: "landing1", widthM: 0.9, x: 1.5, y: 8, state: "closed" },
    { id: "F2", a: "landing1", b: "office1", widthM: 1.0, x: 3, y: 4, state: "open" },
    { id: "F3", a: "office1", b: "meeting1", widthM: 0.9, x: 6, y: 8, state: "open" },
  ],
};

export const OFFICE_DAY: DrillScenario = {
  fire: { room: "office0", item: "stored_boxes" },
  lockedDoors: [],
  occupants: [
    { room: "office0", count: 18, kind: "staff" },
    { room: "reception", count: 2, kind: "staff" },
    { room: "reception", count: 4, kind: "customer" },
    { room: "office1", count: 22, kind: "staff" },
    { room: "meeting1", count: 6, kind: "customer" },
    { room: "office1", count: 1, kind: "mobility_impaired" },
  ],
  alarmDelayS: 45,
  durationS: 600,
  seed: 11,
};

export const SAMPLES = [
  { plan: CAFE, scenario: CAFE_LUNCH, blurb: "Lunch rush, fryer fire in the kitchen." },
  { plan: OFFICE, scenario: OFFICE_DAY, blurb: "Working day, stored boxes catch fire downstairs." },
];
