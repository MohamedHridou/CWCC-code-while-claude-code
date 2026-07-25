import { describe, expect, it } from 'vitest';
import { initialState, isStale, reduce } from '../../src/daemon/session-state.js';
import type { CwccEvent } from '../../src/shared/protocol.js';

// TESTING Layer 1 — pure session state machine (ARCHITECTURE §3).

function ev(event: CwccEvent['event'], extra: Partial<CwccEvent> = {}): CwccEvent {
  return { event, sessionId: 's1', agentId: null, tool: null, ...extra };
}

describe('session-state reducer', () => {
  it('UserPromptSubmit -> BUSY, sets turnStartedAt, picks a seed', () => {
    const s = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    expect(s.status).toBe('BUSY');
    expect(s.turnStartedAt).toBe(1000);
    expect(s.gameSeed).toBeGreaterThan(0);
  });

  it('top-level Stop -> IDLE', () => {
    const busy = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    const idle = reduce(busy, ev('Stop'), 2000);
    expect(idle.status).toBe('IDLE');
    expect(idle.turnStartedAt).toBeNull();
  });

  it('Stop carrying an agentId does NOT end the turn', () => {
    const busy = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    const still = reduce(busy, ev('Stop', { agentId: 'a1' }), 1500);
    expect(still.status).toBe('BUSY');
  });

  it('SubagentStart/Stop adjust depth but never end the turn', () => {
    let s = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    s = reduce(s, ev('SubagentStart'), 1100);
    expect(s.subagentDepth).toBe(1);
    s = reduce(s, ev('SubagentStop'), 1200);
    expect(s.subagentDepth).toBe(0);
    expect(s.status).toBe('BUSY');
  });

  it('UserPromptSubmit while already BUSY is a heartbeat — no restart, no re-seed', () => {
    const busy = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    const again = reduce(busy, ev('UserPromptSubmit'), 5000);
    expect(again.status).toBe('BUSY');
    expect(again.turnStartedAt).toBe(1000); // unchanged
    expect(again.gameSeed).toBe(busy.gameSeed); // unchanged
    expect(again.lastEventAt).toBe(5000);
  });

  it('PreToolUse is a heartbeat that records lastTool, no double-start', () => {
    const busy = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    const hb = reduce(busy, ev('PreToolUse', { tool: 'Bash' }), 1200);
    expect(hb.status).toBe('BUSY');
    expect(hb.lastTool).toBe('Bash');
    expect(hb.turnStartedAt).toBe(1000); // unchanged
  });

  it('watchdog: BUSY + silence past STALE_MS is stale', () => {
    const busy = reduce(initialState('s1', 0), ev('UserPromptSubmit'), 1000);
    expect(isStale(busy, 1000 + 121_000, 120_000)).toBe(true);
    expect(isStale(busy, 1000 + 5_000, 120_000)).toBe(false);
  });

  it('is a pure reducer (does not mutate input)', () => {
    const before = initialState('s1', 0);
    const snapshot = JSON.stringify(before);
    reduce(before, ev('UserPromptSubmit'), 1000);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
