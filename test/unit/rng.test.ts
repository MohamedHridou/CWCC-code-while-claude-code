import { describe, expect, it } from 'vitest';
import { deriveRoundSeed, mulberry32, newSeed, pickIndex } from '../../src/shared/rng.js';

describe('rng', () => {
  it('mulberry32 is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('pickIndex is deterministic and always in range', () => {
    for (const seed of [0, 1, 12345, 0x7fffffff]) {
      for (const len of [1, 2, 8, 21, 100]) {
        const idx = pickIndex(seed, len);
        expect(idx).toBe(pickIndex(seed, len));
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(len);
      }
    }
    expect(pickIndex(99, 0)).toBe(0); // empty pool guard
  });

  it('deriveRoundSeed gives distinct seeds per round, stable per (base, round)', () => {
    const base = 987654321;
    const seeds = new Set([0, 1, 2, 3, 4].map((r) => deriveRoundSeed(base, r)));
    expect(seeds.size).toBe(5);
    expect(deriveRoundSeed(base, 3)).toBe(deriveRoundSeed(base, 3));
  });

  it('newSeed returns an unsigned 31-bit-ish integer', () => {
    for (let i = 0; i < 20; i++) {
      const s = newSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});
