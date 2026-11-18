// Solid angles that the four surfaces of a compartment subtend at a point source (the fire).
// Sources: Tech Ref section 5.1.3 (solid angle of a rectangle as two triangles);
// CFAST 7.7.7 source, radiation.f90 (rdfang, getvrel, solid_angle_triangle).
// Index order: 0 ceiling, 1 upper wall, 2 lower wall, 3 floor.

type Vec3 = readonly [number, number, number];

const FOUR_PI = 4 * Math.PI;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Unit vector from the source point to a corner; the zero vector is left as zero.
function unitFrom(corner: Vec3, source: Vec3): Vec3 {
  const v = sub(corner, source);
  const n = Math.sqrt(dot(v, v));
  return n === 0 ? v : [v[0] / n, v[1] / n, v[2] / n];
}

// Tech Ref section 5.1.3: solid angle of a spherical triangle with unit corner vectors v1, v2, v3,
// tan(omega / 2) = (v1 x v2 . v3) / (1 + v2.v3 + v3.v1 + v1.v2). Result is non-negative (steradian).
export function solidAngleTriangle(v1: Vec3, v2: Vec3, v3: Vec3): number {
  const num = dot(cross(v1, v2), v3);
  const denom = 1 + dot(v2, v3) + dot(v3, v1) + dot(v1, v2);
  return Math.abs(2 * Math.atan2(num, denom));
}

// Tech Ref section 5.1.3: solid angle of a horizontal rectangle (0..x by 0..y at height z) seen from `source`,
// as the sum of two triangles split along a diagonal.
export function horizontalRectangleSolidAngle(
  widthM: number,
  depthM: number,
  planeZM: number,
  source: Vec3,
): number {
  const v1 = unitFrom([0, 0, planeZM], source);
  const v2 = unitFrom([widthM, 0, planeZM], source);
  const v3 = unitFrom([widthM, depthM, planeZM], source);
  const v4 = unitFrom([0, depthM, planeZM], source);
  return solidAngleTriangle(v1, v2, v3) + solidAngleTriangle(v1, v3, v4);
}

// Tech Ref section 5.1.3; CFAST 7.7.7 source, radiation.f90 (rdfang): solid angle of each of the four surfaces
// as seen from a point source at (xM, yM, zM). The ceiling and floor are rectangles; the layer plane is a third
// rectangle that splits the walls: the wall on the same side as the source takes the angle between the layer
// plane and its neighbouring horizontal surface, the other wall takes the rest of the sphere.
// The four values add to 4 pi.
export function fireSolidAngles(
  widthM: number,
  depthM: number,
  heightM: number,
  interfaceHeightM: number,
  xM: number,
  yM: number,
  zM: number,
): number[] {
  // The rectangles 0..W by 0..D are symmetric under x -> W - x and y -> D - y, so the solid angles are too. Evaluating
  // at the reflected position nearest the origin makes mirrored fires give bit-identical angles (Requirement 14.6);
  // without it the two-triangle split rounds differently for x and W - x.
  const source: Vec3 = [Math.min(xM, widthM - xM), Math.min(yM, depthM - yM), zM];
  const ceiling = horizontalRectangleSolidAngle(widthM, depthM, heightM, source);
  const floor = horizontalRectangleSolidAngle(widthM, depthM, 0, source);
  const layer = horizontalRectangleSolidAngle(widthM, depthM, interfaceHeightM, source);
  if (zM < interfaceHeightM) {
    return [ceiling, layer - ceiling, FOUR_PI - layer - floor, floor];
  }
  return [ceiling, FOUR_PI - layer - ceiling, layer - floor, floor];
}
