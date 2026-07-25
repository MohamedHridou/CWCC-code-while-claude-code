/**
 * Deterministic challenge selection across the separated content banks.
 *
 * `pickChallenge(seed, difficulty, lang)` is pure: same inputs => same challenge on every tab (the
 * daemon broadcasts one base seed per turn; rounds derive their own seeds). Selection strategy:
 * ~70% MCQ / ~30% code (from the seed), filtered by language then difficulty, with graceful
 * fallbacks so an empty pool never blanks the UI.
 */

import type { ContentLang, Difficulty } from '../../src/shared/protocol.js';
import { mulberry32, pickIndex } from '../../src/shared/rng.js';
import type { Challenge, CodeItem, McqItem } from './types.js';
import mcqBank from '../content/mcq.json';
import codeBank from '../content/code.json';

const MCQ_ITEMS = mcqBank.items as McqItem[];
const CODE_ITEMS = codeBank.items as CodeItem[];

/** Share of rounds that are MCQ (rest are code drills). */
const MCQ_SHARE = 0.7;

function pool<T extends { lang: ContentLang; difficulty: Difficulty }>(
  items: T[],
  lang: ContentLang,
  difficulty: Difficulty,
): T[] {
  const byLang = items.filter((i) => i.lang === lang);
  const byBoth = byLang.filter((i) => i.difficulty === difficulty);
  if (byBoth.length > 0) return byBoth;
  if (byLang.length > 0) return byLang; // difficulty fallback
  return items; // language fallback (bank misconfigured) — never blank the UI
}

export function pickChallenge(seed: number, difficulty: Difficulty, lang: ContentLang): Challenge {
  const wantMcq = mulberry32(seed)() < MCQ_SHARE;
  const mcqPool = pool(MCQ_ITEMS, lang, difficulty);
  const codePool = pool(CODE_ITEMS, lang, difficulty);

  if ((wantMcq && mcqPool.length > 0) || codePool.length === 0) {
    return { kind: 'mcq', item: mcqPool[pickIndex(seed, mcqPool.length)] };
  }
  return { kind: 'code', item: codePool[pickIndex(seed, codePool.length)] };
}

/** Look up any bank item by id (history panel). */
export function findItem(
  id: string,
): { kind: 'mcq' | 'code'; prompt: string; lang: ContentLang } | null {
  const m = MCQ_ITEMS.find((i) => i.id === id);
  if (m) return { kind: 'mcq', prompt: m.prompt, lang: m.lang };
  const c = CODE_ITEMS.find((i) => i.id === id);
  if (c) return { kind: 'code', prompt: c.prompt, lang: c.lang };
  return null;
}
