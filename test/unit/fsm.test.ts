import { describe, expect, it } from 'vitest';
import { fsmReduce, initialFsmState } from '../../web/fsm.js';
import { deriveRoundSeed } from '../../src/shared/rng.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

const ctx = (now: number) => ({ now });
const srv = (msg: ServerMessage) => ({ kind: 'server' as const, msg });

const turnStart = (t0: number, seed = 111): ServerMessage => ({
  type: 'turn_start',
  sessionId: 's1',
  turnStartedAt: t0,
  gameSeed: seed,
  difficulty: 'med',
});

describe('frontend FSM reducer (no time pressure model)', () => {
  it('hello(IDLE) -> IDLE; hello(BUSY) mounts the first question with a fresh chronometer', () => {
    const idle = fsmReduce(
      initialFsmState,
      srv({ type: 'hello', activeSessionId: null, turn: null }),
      ctx(1000),
    );
    expect(idle.phase).toBe('IDLE');

    const busy = fsmReduce(
      initialFsmState,
      srv({
        type: 'hello',
        activeSessionId: 's1',
        turn: {
          status: 'BUSY',
          turnStartedAt: 0,
          elapsedMs: 40_000,
          gameSeed: 111,
          difficulty: 'med',
        },
      }),
      ctx(40_000),
    );
    expect(busy.phase).toBe('ACTIVE');
    expect(busy.turnActive).toBe(true);
    expect(busy.round).toBe(0); // always start at Q1; no time-derived round
    expect(busy.challengeSeed).toBe(deriveRoundSeed(111, 0));
    expect(busy.questionStartedAt).toBe(40_000); // chronometer starts now
    expect(busy.turnStartedAt).toBe(0); // real turn start (for "working for" banner)
  });

  it('a question has no deadline — it just waits for an answer', () => {
    const s = fsmReduce(initialFsmState, srv(turnStart(0)), ctx(0));
    expect('deadline' in s).toBe(false);
    expect(s.questionStartedAt).toBe(0);
  });

  it('answering records the time spent and shows RESULT; Next advances the round', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0, 222)), ctx(0));
    s = fsmReduce(s, { kind: 'resolve', outcome: 'solved', ms: 8200 }, ctx(8200));
    expect(s.phase).toBe('RESULT');
    expect(s.lastMs).toBe(8200);
    s = fsmReduce(s, { kind: 'result_done' }, ctx(11_000));
    expect(s.phase).toBe('ACTIVE');
    expect(s.round).toBe(1);
    expect(s.challengeSeed).toBe(deriveRoundSeed(222, 1));
    expect(s.questionStartedAt).toBe(11_000); // fresh chronometer
  });

  it('skip advances to the next question without recording', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0, 222)), ctx(0));
    s = fsmReduce(s, { kind: 'skip' }, ctx(3000));
    expect(s.phase).toBe('ACTIVE');
    expect(s.round).toBe(1);
    expect(s.lastOutcome).toBeNull();
    expect(s.questionStartedAt).toBe(3000);
  });

  it('turn_end mid-question -> RESOLVING; question stays, chronometer keeps running', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0)), ctx(0));
    const seedBefore = s.challengeSeed;
    s = fsmReduce(s, srv({ type: 'turn_end', sessionId: 's1', reason: 'stop' }), ctx(5000));
    expect(s.phase).toBe('RESOLVING');
    expect(s.turnActive).toBe(false);
    expect(s.agentDone).toBe(true);
    expect(s.challengeSeed).toBe(seedBefore); // not yanked
    expect(s.questionStartedAt).toBe(0); // chronometer continues from mount
  });

  it('result_done with the turn over -> BREAK (Claude-finished screen)', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0)), ctx(0));
    s = fsmReduce(s, { kind: 'resolve', outcome: 'solved', ms: 4000 }, ctx(4000));
    s = fsmReduce(s, srv({ type: 'turn_end', sessionId: 's1', reason: 'stop' }), ctx(4100));
    expect(s.phase).toBe('RESULT'); // explanation lingers
    s = fsmReduce(s, { kind: 'result_done' }, ctx(6500));
    expect(s.phase).toBe('BREAK');
  });

  it('BREAK -> Keep playing enters free play and chains; Back to Claude Code -> IDLE', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0, 333)), ctx(0));
    s = fsmReduce(s, { kind: 'resolve', outcome: 'solved', ms: 4000 }, ctx(4000));
    s = fsmReduce(s, srv({ type: 'turn_end', sessionId: 's1', reason: 'stop' }), ctx(4100));
    s = fsmReduce(s, { kind: 'result_done' }, ctx(6500));
    expect(s.phase).toBe('BREAK');

    const stopped = fsmReduce(s, { kind: 'stop_play' }, ctx(7000));
    expect(stopped.phase).toBe('IDLE');

    let free = fsmReduce(s, { kind: 'continue_play' }, ctx(7000));
    expect(free.phase).toBe('ACTIVE');
    expect(free.freePlay).toBe(true);
    expect(free.round).toBe(1);
    // Free play chains through RESULT -> next question, until the user stops.
    free = fsmReduce(free, { kind: 'resolve', outcome: 'failed', ms: 5000 }, ctx(12_000));
    free = fsmReduce(free, { kind: 'result_done' }, ctx(14_000));
    expect(free.phase).toBe('ACTIVE');
    expect(free.freePlay).toBe(true);
    expect(free.round).toBe(2);
    const done = fsmReduce(free, { kind: 'stop_play' }, ctx(15_000));
    expect(done.phase).toBe('IDLE');
    expect(done.freePlay).toBe(false);
  });

  it('dismiss in RESOLVING -> BREAK; a real turn_start takes over free play', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0, 333)), ctx(0));
    s = fsmReduce(s, srv({ type: 'turn_end', sessionId: 's1', reason: 'stop' }), ctx(1000));
    s = fsmReduce(s, { kind: 'dismiss' }, ctx(1100));
    expect(s.phase).toBe('BREAK');
    s = fsmReduce(s, { kind: 'continue_play' }, ctx(1200));
    expect(s.freePlay).toBe(true);
    s = fsmReduce(s, srv(turnStart(50_000, 999)), ctx(50_000));
    expect(s.phase).toBe('ACTIVE');
    expect(s.freePlay).toBe(false);
    expect(s.turnActive).toBe(true);
    expect(s.round).toBe(0);
    expect(s.challengeSeed).toBe(deriveRoundSeed(999, 0));
  });

  it('ws close from any phase -> DISCONNECTED', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0)), ctx(0));
    s = fsmReduce(s, { kind: 'ws_close' }, ctx(1));
    expect(s.phase).toBe('DISCONNECTED');
  });

  it('heartbeat and stats_update do not disturb the question', () => {
    let s = fsmReduce(initialFsmState, srv(turnStart(0)), ctx(0));
    const before = s;
    s = fsmReduce(s, srv({ type: 'heartbeat', sessionId: 's1', elapsedMs: 3000 }), ctx(3000));
    s = fsmReduce(
      s,
      srv({
        type: 'stats_update',
        streak: 2,
        best: 5,
        todaySolved: 1,
        totalSolved: 9,
        recent: [],
      }),
      ctx(3100),
    );
    expect(s).toEqual(before);
  });
});
