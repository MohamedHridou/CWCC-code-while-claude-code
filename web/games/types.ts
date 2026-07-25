/**
 * Game content model — two separated content pipelines (per product decision, 2026-07-18):
 *
 *  - MCQ  (`web/content/mcq.json`):  question + options, one correct answer. Covers spot-the-bug,
 *    predict-the-output, Big-O, language trivia.
 *  - CODE (`web/content/code.json`): question + typed answer, checked by an *evaluator*.
 *
 * Evaluators are deliberately pluggable: v1 ships deterministic offline matchers (exact / normalized /
 * regex). A real executor (running user code) can implement the same contract later, but true Python/
 * Java execution needs heavyweight runtimes and would break the offline invariant — so answers are
 * "predict the output / write the expression" style, which a matcher can grade honestly.
 */

import type { ContentLang, Difficulty } from '../../src/shared/protocol.js';

interface BaseItem {
  id: string;
  lang: ContentLang;
  difficulty: Difficulty;
  /** The question, shown prominently above the code. */
  prompt: string;
  /** Optional code snippet displayed in the editor card. */
  code?: string[];
  explanation: string;
  tags: string[];
}

export interface McqItem extends BaseItem {
  options: string[];
  answerIndex: number;
}

export type Evaluator =
  | { type: 'exact'; expected: string | string[] }
  | { type: 'normalized'; expected: string | string[] }
  | { type: 'regex'; pattern: string };

export interface CodeItem extends BaseItem {
  evaluator: Evaluator;
  /** Placeholder hint for the answer input. */
  placeholder?: string;
}

export type Challenge = { kind: 'mcq'; item: McqItem } | { kind: 'code'; item: CodeItem };

function toArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Grade a typed answer against an evaluator. Pure and deterministic. */
export function evaluate(ev: Evaluator, answer: string): boolean {
  const ans = answer.trim();
  if (ans.length === 0) return false;
  switch (ev.type) {
    case 'exact':
      return toArray(ev.expected).some((e) => e.trim() === ans);
    case 'normalized': {
      const n = normalize(ans);
      return toArray(ev.expected).some((e) => normalize(e) === n);
    }
    case 'regex':
      try {
        return new RegExp(`^(?:${ev.pattern})$`).test(ans);
      } catch {
        return false;
      }
  }
}

/** Human-readable expected answer for the RESULT screen. */
export function expectedAnswer(ev: Evaluator): string {
  switch (ev.type) {
    case 'exact':
    case 'normalized':
      return toArray(ev.expected)[0];
    case 'regex':
      return ev.pattern;
  }
}
