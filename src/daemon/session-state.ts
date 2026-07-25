/**
 * Pure session state machine: (state, event, now) -> state. See ARCHITECTURE §3.
 *
 * Turn START = UserPromptSubmit; turn END = top-level Stop only. A Stop carrying an agentId is a subagent
 * stop and MUST NOT end the turn. PreToolUse/PostToolUse/PostToolBatch are heartbeats (+ difficulty hint).
 * This is a pure function so it unit-tests without a running server (TESTING Layer 1).
 */

import type { CwccEvent, SessionState } from '../shared/protocol.js';
import { newSeed } from '../shared/rng.js';

export function initialState(sessionId: string, now: number): SessionState {
  return {
    sessionId,
    status: 'IDLE',
    turnStartedAt: null,
    lastEventAt: now,
    lastTool: null,
    subagentDepth: 0,
    gameSeed: 0,
    stale: false,
  };
}

/** Pure reducer. Returns a new state; never mutates the input. */
export function reduce(state: SessionState, event: CwccEvent, now: number): SessionState {
  const base: SessionState = { ...state, lastEventAt: now };

  switch (event.event) {
    case 'UserPromptSubmit':
      // A prompt queued while the agent is already BUSY (same turn window from the dev's point of
      // view) must NOT restart the turn or re-seed — every tab would abruptly swap its challenge.
      if (state.status === 'BUSY') return base;
      return {
        ...base,
        status: 'BUSY',
        turnStartedAt: now,
        gameSeed: newSeed(),
        subagentDepth: 0,
        stale: false,
      };

    case 'PreToolUse':
      // Heartbeat + difficulty hint. Never starts or ends a turn.
      return { ...base, lastTool: event.tool };

    case 'PostToolUse':
    case 'PostToolBatch':
      // Heartbeat only.
      return base;

    case 'SubagentStart':
      return { ...base, subagentDepth: base.subagentDepth + 1 };

    case 'SubagentStop':
      // Nested work ending MUST NOT end the turn.
      return { ...base, subagentDepth: Math.max(0, base.subagentDepth - 1) };

    case 'Stop':
      // Only a TOP-LEVEL Stop ends the turn. A Stop with an agentId is a subagent — ignore for turn-end.
      if (event.agentId) return base;
      return {
        ...base,
        status: 'IDLE',
        turnStartedAt: null,
        subagentDepth: 0,
        stale: false,
      };

    case 'SessionEnd':
      // Session gone; the store removes it. End any active turn.
      return { ...base, status: 'IDLE', turnStartedAt: null };

    default:
      return base;
  }
}

/** Watchdog check: a BUSY session with no event for `staleMs` (and no Stop) is stale. */
export function isStale(state: SessionState, now: number, staleMs: number): boolean {
  return state.status === 'BUSY' && !state.stale && now - state.lastEventAt > staleMs;
}
