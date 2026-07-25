/**
 * Local stats/streak store persisted atomically to ~/.claude/cwcc/stats.json (GAMES.md schema).
 *
 * - Streak = consecutive calendar days with >=1 solved challenge.
 * - History is a capped ring buffer (HISTORY_CAP). Writes are atomic (temp + rename).
 * - Corrupt/absent file => start fresh and log.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HISTORY_CAP, ROLLING_ACCURACY_CAP } from '../shared/constants.js';
import type {
  ChallengeResultMsg,
  Difficulty,
  GameMode,
  Outcome,
  StatsUpdateMsg,
} from '../shared/protocol.js';
import { log } from '../shared/logger.js';
import { statsPath } from '../shared/paths.js';

interface ModeStats {
  seen: number;
  solved: number;
  avgMs: number;
  bestMs: number | null;
  rollingAccuracy: number[];
}

interface HistoryEntry {
  ts: number;
  mode: GameMode;
  outcome: Outcome;
  ms: number;
  seed: number;
  /** Bank item id (absent in entries persisted before this field existed). */
  itemId?: string | null;
}

export interface Stats {
  version: 1;
  totals: { solved: number; failed: number; timeout: number };
  byMode: Record<GameMode, ModeStats>;
  streak: { current: number; best: number; lastActiveDay: string | null };
  history: HistoryEntry[];
}

function emptyMode(): ModeStats {
  return { seen: 0, solved: 0, avgMs: 0, bestMs: null, rollingAccuracy: [] };
}

export function freshStats(): Stats {
  return {
    version: 1,
    totals: { solved: 0, failed: 0, timeout: 0 },
    byMode: {
      mcq: emptyMode(),
      code: emptyMode(),
      'bug-hunt': emptyMode(),
      'big-o': emptyMode(),
      syntax: emptyMode(),
    },
    streak: { current: 0, best: 0, lastActiveDay: null },
    history: [],
  };
}

export function loadStats(): Stats {
  try {
    const parsed = JSON.parse(readFileSync(statsPath(), 'utf8')) as Partial<Stats>;
    if (parsed && parsed.version === 1 && parsed.byMode && parsed.totals && parsed.streak) {
      return parsed as Stats;
    }
    log.warn('stats file malformed; starting fresh');
  } catch {
    // Absent/corrupt => fresh (logged at debug to avoid noise on first run).
    log.debug('no stats file; starting fresh');
  }
  return freshStats();
}

function saveStats(stats: Stats): void {
  try {
    const dir = dirname(statsPath());
    mkdirSync(dir, { recursive: true });
    const tmp = statsPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(stats, null, 2), { mode: 0o600 });
    renameSync(tmp, statsPath()); // atomic on same volume
  } catch (err) {
    log.error('failed to persist stats', { error: String(err) });
  }
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / 86_400_000);
}

/** Fold one challenge result into the store and persist. Returns the updated snapshot. */
export function recordResult(result: ChallengeResultMsg, now = Date.now()): Stats {
  const stats = loadStats();
  const m = stats.byMode[result.mode] ?? emptyMode();

  m.seen += 1;
  m.rollingAccuracy.push(result.outcome === 'solved' ? 1 : 0);
  if (m.rollingAccuracy.length > ROLLING_ACCURACY_CAP) m.rollingAccuracy.shift();

  if (result.outcome === 'solved') {
    const prevSolved = m.solved;
    m.avgMs = Math.round((m.avgMs * prevSolved + result.ms) / (prevSolved + 1));
    m.solved += 1;
    if (m.bestMs === null || result.ms < m.bestMs) m.bestMs = result.ms;
  }
  stats.byMode[result.mode] = m;

  stats.totals[result.outcome] += 1;

  if (result.outcome === 'solved') {
    const today = dayKey(now);
    const last = stats.streak.lastActiveDay;
    if (last === today) {
      // already counted today
    } else if (last && daysBetween(last, today) === 1) {
      stats.streak.current += 1;
    } else {
      stats.streak.current = 1;
    }
    stats.streak.lastActiveDay = today;
    if (stats.streak.current > stats.streak.best) stats.streak.best = stats.streak.current;
  }

  stats.history.push({
    ts: now,
    mode: result.mode,
    outcome: result.outcome,
    ms: result.ms,
    seed: result.seed,
    itemId: result.itemId ?? null,
  });
  if (stats.history.length > HISTORY_CAP) {
    stats.history.splice(0, stats.history.length - HISTORY_CAP);
  }

  saveStats(stats);
  return stats;
}

/** How many history rows ship in each stats_update (glanceable panel, not a log). */
const RECENT_CAP = 8;

/** Build the `stats_update` wire message from a stats snapshot. */
export function toStatsUpdate(stats: Stats, now = Date.now()): StatsUpdateMsg {
  const today = dayKey(now);
  const todaySolved = stats.history.filter(
    (h) => h.outcome === 'solved' && dayKey(h.ts) === today,
  ).length;
  const recent = stats.history
    .slice(-RECENT_CAP)
    .reverse()
    .map((h) => ({
      ts: h.ts,
      mode: h.mode,
      outcome: h.outcome,
      ms: h.ms,
      itemId: h.itemId ?? null,
    }));
  return {
    type: 'stats_update',
    streak: stats.streak.current,
    best: stats.streak.best,
    todaySolved,
    totalSolved: stats.totals.solved,
    recent,
  };
}

/**
 * Difficulty ramp (GAMES.md): last-5 rolling accuracy > 0.8 biases one step harder, < 0.4 easier.
 * Fewer than 3 data points => default 'med'.
 */
export function suggestDifficulty(stats: Stats, mode: GameMode): Difficulty {
  const acc = stats.byMode[mode]?.rollingAccuracy ?? [];
  const last5 = acc.slice(-5);
  if (last5.length < 3) return 'med';
  const a = last5.reduce((s, x) => s + x, 0) / last5.length;
  if (a > 0.8) return 'hard';
  if (a < 0.4) return 'easy';
  return 'med';
}
