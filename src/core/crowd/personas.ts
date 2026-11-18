// Occupant types. Walking speed 1.19 m/s is the SFPE Handbook unimpeded value (secondary source); the other speeds and
// all pre-movement ranges are estimates and are labelled as such in the app.
import type { PersonaKind } from "../plan/scenario";

export interface Persona {
  kind: PersonaKind;
  label: string;
  speedMS: number;
  stairSpeedMS: number; // along the flight
  preMovementS: [number, number]; // uniform range after the alarm
  knowsAllExits: boolean;
  description: string; // given to the AI as the person's background
}

export const PERSONAS: Record<PersonaKind, Persona> = {
  customer: {
    kind: "customer", label: "Customer", speedMS: 1.19, stairSpeedMS: 0.6, preMovementS: [20, 90], knowsAllExits: false,
    description: "A customer or visitor. Knows the way they came in and any exit with a lit sign; does not know staff areas.",
  },
  staff: {
    kind: "staff", label: "Staff", speedMS: 1.19, stairSpeedMS: 0.65, preMovementS: [10, 40], knowsAllExits: true,
    description: "A member of staff. Knows every door and exit, including staff-only areas, and is expected to help others out.",
  },
  resident: {
    kind: "resident", label: "Resident", speedMS: 1.19, stairSpeedMS: 0.6, preMovementS: [60, 240], knowsAllExits: true,
    description: "Lives in the building and knows every door. May be asleep when the fire starts and needs time to wake and react.",
  },
  elderly: {
    kind: "elderly", label: "Older adult", speedMS: 0.9, stairSpeedMS: 0.4, preMovementS: [40, 120], knowsAllExits: false,
    description: "An older visitor who walks slowly and is cautious on stairs. Knows only the entrance and signed exits.",
  },
  parent_with_child: {
    kind: "parent_with_child", label: "Parent with child", speedMS: 0.95, stairSpeedMS: 0.45, preMovementS: [30, 90], knowsAllExits: false,
    description: "A parent with a young child. Will not leave without the child; moves at the child's pace.",
  },
  mobility_impaired: {
    kind: "mobility_impaired", label: "Wheelchair user", speedMS: 0.7, stairSpeedMS: 0.1, preMovementS: [60, 150], knowsAllExits: false,
    description: "Uses a wheelchair. Cannot use stairs without being carried; can wait in a protected stair for rescue.",
  },
};
