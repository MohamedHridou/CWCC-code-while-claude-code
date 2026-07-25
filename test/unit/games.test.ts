import { describe, expect, it } from 'vitest';
import { findItem, pickChallenge } from '../../web/games/registry.js';
import { evaluate } from '../../web/games/types.js';

describe('challenge registry', () => {
  it('is deterministic: same (seed, difficulty, lang) => same challenge', () => {
    for (const seed of [1, 42, 987654321]) {
      const a = pickChallenge(seed, 'med', 'python');
      const b = pickChallenge(seed, 'med', 'python');
      expect(a.kind).toBe(b.kind);
      expect(a.item.id).toBe(b.item.id);
    }
  });

  it('respects the language filter', () => {
    for (let seed = 0; seed < 40; seed++) {
      expect(pickChallenge(seed, 'med', 'python').item.lang).toBe('python');
      expect(pickChallenge(seed, 'easy', 'java').item.lang).toBe('java');
    }
  });

  it('serves both MCQ and code kinds across seeds', () => {
    const kinds = new Set<string>();
    for (let seed = 0; seed < 60; seed++) kinds.add(pickChallenge(seed, 'med', 'java').kind);
    expect(kinds).toEqual(new Set(['mcq', 'code']));
  });

  it('falls back to the language pool when a difficulty has no items', () => {
    // Even if a (lang, difficulty) pool were empty, pick never returns undefined.
    for (let seed = 0; seed < 20; seed++) {
      expect(pickChallenge(seed, 'hard', 'python').item).toBeDefined();
    }
  });

  it('findItem resolves ids from both banks for the history panel', () => {
    expect(findItem('py-mcq-001')?.kind).toBe('mcq');
    expect(findItem('java-code-001')?.kind).toBe('code');
    expect(findItem('nope-404')).toBeNull();
  });
});

describe('answer evaluator', () => {
  it('exact: trims but is otherwise strict', () => {
    expect(evaluate({ type: 'exact', expected: '7' }, ' 7 ')).toBe(true);
    expect(evaluate({ type: 'exact', expected: '7' }, '7.0')).toBe(false);
    expect(evaluate({ type: 'exact', expected: ['x', 'y'] }, 'y')).toBe(true);
    expect(evaluate({ type: 'exact', expected: '7' }, '')).toBe(false);
  });

  it('normalized: collapses whitespace, accepts alternates', () => {
    const ev = {
      type: 'normalized' as const,
      expected: ['x >= 1 and x <= 10', '1 <= x <= 10'],
    };
    expect(evaluate(ev, 'x >= 1   and x <= 10')).toBe(true);
    expect(evaluate(ev, '1 <= x <= 10')).toBe(true);
    expect(evaluate(ev, 'x > 1 and x < 10')).toBe(false);
  });

  it('regex: full-match semantics, invalid patterns never throw', () => {
    expect(evaluate({ type: 'regex', pattern: '[Oo]\\(n\\)' }, 'O(n)')).toBe(true);
    expect(evaluate({ type: 'regex', pattern: 'O\\(n\\)' }, 'xO(n)y')).toBe(false);
    expect(evaluate({ type: 'regex', pattern: '(' }, 'anything')).toBe(false);
  });
});
