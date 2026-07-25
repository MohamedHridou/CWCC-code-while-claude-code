import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  freshStats,
  loadStats,
  recordResult,
  suggestDifficulty,
  toStatsUpdate,
} from '../../src/daemon/stats.js';
import { statsPath } from '../../src/shared/paths.js';
import type { ChallengeResultMsg } from '../../src/shared/protocol.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-18T12:00:00Z');

const result = (over: Partial<ChallengeResultMsg> = {}): ChallengeResultMsg => ({
  type: 'challenge_result',
  mode: 'bug-hunt',
  outcome: 'solved',
  ms: 4000,
  seed: 1,
  ...over,
});

describe('stats store', () => {
  beforeEach(() => {
    // Isolate every test in its own fake HOME; paths.ts resolves homedir() lazily.
    process.env.HOME = mkdtempSync(join(tmpdir(), 'cwcc-stats-'));
  });

  it('persists atomically and reloads', () => {
    recordResult(result(), T0);
    const loaded = loadStats();
    expect(loaded.totals.solved).toBe(1);
    expect(loaded.byMode['bug-hunt'].seen).toBe(1);
    expect(loaded.byMode['bug-hunt'].bestMs).toBe(4000);
    expect(JSON.parse(readFileSync(statsPath(), 'utf8')).version).toBe(1);
  });

  it('streak: same day counts once, consecutive days increment, a gap resets', () => {
    let s = recordResult(result(), T0);
    expect(s.streak.current).toBe(1);
    s = recordResult(result(), T0 + 3600_000); // same day
    expect(s.streak.current).toBe(1);
    s = recordResult(result(), T0 + DAY); // next day
    expect(s.streak.current).toBe(2);
    expect(s.streak.best).toBe(2);
    s = recordResult(result(), T0 + 4 * DAY); // 3-day gap
    expect(s.streak.current).toBe(1);
    expect(s.streak.best).toBe(2);
  });

  it('failed/timeout update totals and rolling accuracy but not the streak', () => {
    let s = recordResult(result({ outcome: 'failed' }), T0);
    s = recordResult(result({ outcome: 'timeout' }), T0);
    expect(s.streak.current).toBe(0);
    expect(s.totals.failed).toBe(1);
    expect(s.totals.timeout).toBe(1);
    expect(s.byMode['bug-hunt'].rollingAccuracy).toEqual([0, 0]);
  });

  it('history is capped', () => {
    let s = freshStats();
    for (let i = 0; i < 210; i++) s = recordResult(result({ seed: i }), T0 + i * 1000);
    expect(s.history.length).toBe(200);
    expect(s.history[0].seed).toBe(10); // oldest 10 dropped
  });

  it('corrupt stats file starts fresh instead of crashing', () => {
    mkdirSync(join(process.env.HOME as string, '.claude', 'cwcc'), {
      recursive: true,
    });
    writeFileSync(statsPath(), '{not json');
    expect(loadStats().totals.solved).toBe(0);
    expect(recordResult(result(), T0).totals.solved).toBe(1);
  });

  it('toStatsUpdate reports today-solved for the given day only', () => {
    recordResult(result(), T0 - DAY);
    const s = recordResult(result(), T0);
    const upd = toStatsUpdate(s, T0);
    expect(upd.todaySolved).toBe(1);
    expect(upd.totalSolved).toBe(2);
  });

  it('suggestDifficulty ramps on last-5 accuracy', () => {
    const s = freshStats();
    expect(suggestDifficulty(s, 'bug-hunt')).toBe('med'); // no data
    s.byMode['bug-hunt'].rollingAccuracy = [1, 1, 1, 1, 1];
    expect(suggestDifficulty(s, 'bug-hunt')).toBe('hard');
    s.byMode['bug-hunt'].rollingAccuracy = [0, 0, 1, 0, 0];
    expect(suggestDifficulty(s, 'bug-hunt')).toBe('easy');
    s.byMode['bug-hunt'].rollingAccuracy = [1, 0, 1, 0, 1];
    expect(suggestDifficulty(s, 'bug-hunt')).toBe('med');
  });
});
