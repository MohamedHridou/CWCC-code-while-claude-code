/**
 * Offline content-bank validator (GAMES.md, TESTING Layer 1). Run in CI and before authoring commits.
 *
 * Active banks:
 *  - mcq.json  — options (2..6), answerIndex in range, lang ∈ {python, java}, non-empty prompt.
 *  - code.json — evaluator (exact/normalized/regex) with non-empty expected/pattern, lang, prompt.
 *
 * Exits non-zero on any violation so CI fails loudly. Content is data — this is the guardrail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, '..', 'web', 'content');
const LANGS = ['python', 'java'];
const DIFFS = ['easy', 'med', 'hard'];

type Problem = string;
type Bank = { version?: unknown; mode?: unknown; items?: unknown };
type Item = Record<string, unknown>;

function loadBank(name: string): { bank: Bank | null; problems: Problem[] } {
  const path = join(CONTENT_DIR, `${name}.json`);
  try {
    return { bank: JSON.parse(readFileSync(path, 'utf8')), problems: [] };
  } catch (err) {
    return {
      bank: null,
      problems: [`${name}.json: cannot read/parse — ${String(err)}`],
    };
  }
}

function baseChecks(
  name: string,
  bank: Bank,
  seen: Set<string>,
): { items: Item[]; problems: Problem[] } {
  const problems: Problem[] = [];
  if (typeof bank.version !== 'number') problems.push(`${name}.json: missing numeric "version"`);
  if (bank.mode !== name) problems.push(`${name}.json: "mode" must equal "${name}"`);
  if (!Array.isArray(bank.items)) {
    problems.push(`${name}.json: "items" must be an array`);
    return { items: [], problems };
  }
  bank.items.forEach((raw, i) => {
    const item = raw as Item;
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0) {
      problems.push(`${name}.json[${i}]: missing string "id"`);
    } else if (seen.has(id)) {
      problems.push(`${name}.json[${i}]: duplicate id "${id}" (ids are global across banks)`);
    } else {
      seen.add(id);
    }
  });
  return { items: bank.items as Item[], problems };
}

function checkActiveItem(name: string, i: number, item: Item): Problem[] {
  const p: Problem[] = [];
  const id = String(item.id ?? i);
  if (!LANGS.includes(item.lang as string))
    p.push(`${name}.json[${i}] (${id}): "lang" must be one of ${LANGS.join('/')}`);
  if (!DIFFS.includes(item.difficulty as string))
    p.push(`${name}.json[${i}] (${id}): bad "difficulty"`);
  if (typeof item.prompt !== 'string' || item.prompt.length === 0)
    p.push(`${name}.json[${i}] (${id}): missing "prompt"`);
  if (typeof item.explanation !== 'string' || item.explanation.length === 0)
    p.push(`${name}.json[${i}] (${id}): missing "explanation"`);
  if (item.code !== undefined && (!Array.isArray(item.code) || item.code.length === 0)) {
    p.push(`${name}.json[${i}] (${id}): "code" must be a non-empty array when present`);
  }
  return p;
}

function validateMcq(): Problem[] {
  const { bank, problems } = loadBank('mcq');
  if (!bank) return problems;
  const { items, problems: base } = baseChecks('mcq', bank, globalIds);
  problems.push(...base);
  items.forEach((item, i) => {
    problems.push(...checkActiveItem('mcq', i, item));
    const id = String(item.id ?? i);
    const options = item.options;
    const answer = item.answerIndex;
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
      problems.push(`mcq.json[${i}] (${id}): "options" must have 2..6 entries`);
    } else if (
      typeof answer !== 'number' ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= options.length
    ) {
      problems.push(`mcq.json[${i}] (${id}): "answerIndex" out of range`);
    }
  });
  return problems;
}

function validateCode(): Problem[] {
  const { bank, problems } = loadBank('code');
  if (!bank) return problems;
  const { items, problems: base } = baseChecks('code', bank, globalIds);
  problems.push(...base);
  items.forEach((item, i) => {
    problems.push(...checkActiveItem('code', i, item));
    const id = String(item.id ?? i);
    const ev = item.evaluator as Item | undefined;
    if (!ev || typeof ev !== 'object') {
      problems.push(`code.json[${i}] (${id}): missing "evaluator"`);
      return;
    }
    if (ev.type === 'exact' || ev.type === 'normalized') {
      const exp = ev.expected;
      const arr = Array.isArray(exp) ? exp : [exp];
      if (arr.length === 0 || arr.some((e) => typeof e !== 'string' || e.length === 0)) {
        problems.push(`code.json[${i}] (${id}): evaluator "expected" must be non-empty string(s)`);
      }
    } else if (ev.type === 'regex') {
      if (typeof ev.pattern !== 'string' || ev.pattern.length === 0) {
        problems.push(`code.json[${i}] (${id}): regex evaluator needs a "pattern"`);
      } else {
        try {
          new RegExp(ev.pattern);
        } catch {
          problems.push(`code.json[${i}] (${id}): invalid regex pattern`);
        }
      }
    } else {
      problems.push(`code.json[${i}] (${id}): evaluator "type" must be exact|normalized|regex`);
    }
  });
  return problems;
}

const globalIds = new Set<string>();
const allProblems = [...validateMcq(), ...validateCode()];

if (allProblems.length > 0) {
  console.error('Content validation FAILED:');
  for (const p of allProblems) console.error('  - ' + p);
  process.exit(1);
}

console.log('Content validation OK (mcq, code).');
