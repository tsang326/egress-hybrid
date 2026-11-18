// Seeded pseudo-random generator (Req 11.3). Used by tests and generators; the physics uses no randomness.
// mulberry32, public domain, by Tommy Ettinger.

export type Prng = () => number;

/** Returns a generator of floats in [0, 1). Same seed gives the same sequence. */
export function createPrng(seed: number): Prng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
