/**
 * Tiny deterministic RNG shared by daemon and web. Pure, no Node/DOM deps.
 *
 * Determinism is the whole point (GAMES.md): the daemon picks ONE `gameSeed` per turn and broadcasts it,
 * and every tab derives the identical challenge via `pickIndex(seed, n)`. Same seed ⇒ same output.
 */

/** mulberry32 PRNG: seed -> generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic index into a bank of `length` items from a seed. */
export function pickIndex(seed: number, length: number): number {
  if (length <= 0) return 0;
  return Math.floor(mulberry32(seed)() * length);
}

/** A fresh, well-spread 31-bit seed. Used by the daemon at turn start. */
export function newSeed(): number {
  return (Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0x7fffffff)) >>> 0;
}

/**
 * Derive the seed for round `round` of a turn from the turn's base seed (Knuth multiplicative mix).
 * Long turns cycle through multiple drills; every tab derives the same per-round challenge from the
 * broadcast base seed, so late-joiners land on the same drill as everyone else.
 */
export function deriveRoundSeed(baseSeed: number, round: number): number {
  return (baseSeed ^ Math.imul(round + 1, 2654435761)) >>> 0;
}
