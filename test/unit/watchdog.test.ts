import { describe, expect, it } from 'vitest';
import { findStaleSessions } from '../../src/daemon/watchdog.js';
import type { SessionState } from '../../src/shared/protocol.js';

function session(over: Partial<SessionState>): SessionState {
  return {
    sessionId: 's',
    status: 'IDLE',
    turnStartedAt: null,
    lastEventAt: 0,
    lastTool: null,
    subagentDepth: 0,
    gameSeed: 1,
    stale: false,
    ...over,
  };
}

describe('watchdog', () => {
  it('flags only BUSY sessions silent past staleMs', () => {
    const sessions = [
      session({ sessionId: 'busy-stale', status: 'BUSY', lastEventAt: 0 }),
      session({ sessionId: 'busy-fresh', status: 'BUSY', lastEventAt: 9_500 }),
      session({ sessionId: 'idle-old', status: 'IDLE', lastEventAt: 0 }),
      session({
        sessionId: 'already-stale',
        status: 'BUSY',
        lastEventAt: 0,
        stale: true,
      }),
    ];
    expect(findStaleSessions(sessions, 10_000, 1_000)).toEqual(['busy-stale']);
  });

  it('returns empty for an empty map', () => {
    expect(findStaleSessions([], 10_000, 1_000)).toEqual([]);
  });
});
