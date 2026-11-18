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

// A terraced house let as shared rooms (an HMO): one stair, bedrooms on two upper floors, a fire at night.
const H = 2.6;
const floorRooms = (f: number, names: [string, string, string]) => [
  { id: `stair${f}`, name: f === 0 ? "Stair (ground)" : `Stair (floor ${f})`, floor: f, x: 0, y: 0, widthM: 2, depthM: 4, heightM: 2.8, kind: "stair" as const },
  { id: `hall${f}`, name: f === 0 ? "Hall" : `Landing ${f}`, floor: f, x: 2, y: 0, widthM: 1.5, depthM: 10, heightM: H, kind: "corridor" as const },
  { id: `${names[0].toLowerCase().replace(/\W+/g, "")}`, name: names[0], floor: f, x: 3.5, y: 0, widthM: 2.8, depthM: 5, heightM: H, kind: "room" as const },
  { id: `${names[1].toLowerCase().replace(/\W+/g, "")}`, name: names[1], floor: f, x: 3.5, y: 5, widthM: 2.8, depthM: 5, heightM: H, kind: "room" as const },
  { id: `${names[2].toLowerCase().replace(/\W+/g, "")}`, name: names[2], floor: f, x: 0, y: 4, widthM: 2, depthM: 6, heightM: H, kind: "room" as const },
];

export const HOUSE: Plan = {
  schemaVersion: 1,
  title: "Shared house (3 floors)",
  floorHeightM: 2.8,
  rooms: [
    ...floorRooms(0, ["Lounge", "Kitchen", "WC"]),
    ...floorRooms(1, ["Bedroom 1", "Bedroom 2", "Bathroom"]),
    ...floorRooms(2, ["Bedroom 3", "Bedroom 4", "Shower room"]),
  ],
  doors: [
    { id: "FD", a: "hall0", b: OUTSIDE, widthM: 0.9, x: 2.75, y: 0, state: "closed", mainEntrance: true },
    { id: "BD", a: "kitchen", b: OUTSIDE, widthM: 0.8, x: 4.9, y: 10, state: "closed" },
    { id: "L0", a: "hall0", b: "lounge", widthM: 0.8, x: 3.5, y: 2.5, state: "open" },
    { id: "K0", a: "hall0", b: "kitchen", widthM: 0.8, x: 3.5, y: 7.5, state: "closed" },
    { id: "W0", a: "hall0", b: "wc", widthM: 0.7, x: 2, y: 7, state: "closed" },
    { id: "T0", a: "hall0", b: "stair0", widthM: 0.9, x: 2, y: 2, state: "open" },
    { id: "S1", a: "stair0", b: "stair1", widthM: 0.9, x: 1, y: 2, state: "open", stair: { lengthM: 6 } },
    { id: "T1", a: "hall1", b: "stair1", widthM: 0.9, x: 2, y: 2, state: "open" },
    { id: "R1", a: "hall1", b: "bedroom1", widthM: 0.8, x: 3.5, y: 2.5, state: "closed" },
    { id: "R2", a: "hall1", b: "bedroom2", widthM: 0.8, x: 3.5, y: 7.5, state: "closed" },
    { id: "B1", a: "hall1", b: "bathroom", widthM: 0.7, x: 2, y: 7, state: "closed" },
    { id: "S2", a: "stair1", b: "stair2", widthM: 0.9, x: 1, y: 2, state: "open", stair: { lengthM: 6 } },
    { id: "T2", a: "hall2", b: "stair2", widthM: 0.9, x: 2, y: 2, state: "open" },
    { id: "R3", a: "hall2", b: "bedroom3", widthM: 0.8, x: 3.5, y: 2.5, state: "closed" },
    { id: "R4", a: "hall2", b: "bedroom4", widthM: 0.8, x: 3.5, y: 7.5, state: "closed" },
    { id: "B2", a: "hall2", b: "showerroom", widthM: 0.7, x: 2, y: 7, state: "closed" },
  ],
};

export const HOUSE_NIGHT: DrillScenario = {
  fire: { room: "lounge", item: "upholstered_chair" },
  lockedDoors: ["BD"],
  occupants: [
    { room: "bedroom1", count: 1, kind: "resident" },
    { room: "bedroom2", count: 2, kind: "resident" },
    { room: "bedroom3", count: 1, kind: "resident" },
    { room: "bedroom4", count: 1, kind: "elderly" },
  ],
  alarmDelayS: 60,
  durationS: 600,
  seed: 5,
};

export const SAMPLES = [
  { id: "cafe", plan: CAFE, scenario: CAFE_LUNCH, blurb: "Lunch rush, fryer fire in the kitchen." },
  { id: "office", plan: OFFICE, scenario: OFFICE_DAY, blurb: "Working day, stored boxes catch fire downstairs." },
  { id: "house", plan: HOUSE, scenario: HOUSE_NIGHT, blurb: "3 a.m., an armchair catches fire in the lounge with its door open; the back door is locked." },
];
