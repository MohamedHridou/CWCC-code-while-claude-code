/**
 * Frontend FSM as a pure reducer (state, action, ctx) -> state. Unit-testable.
 * Product model (2026-07-19): NO drill time pressure — a question lasts as long as Claude is working.
 *
 *   DISCONNECTED --hello--> IDLE
 *   IDLE --turn_start / hello(BUSY)--> ACTIVE(question, count-up chronometer, no deadline)
 *   ACTIVE --answer--> RESULT --result_done/next--> next question (turn busy OR free play)
 *   ACTIVE --skip--> next question (no record)
 *   ACTIVE --turn_end--> RESOLVING            (Claude done mid-question: keep it, never yank)
 *   RESOLVING --answer--> RESULT ;  RESOLVING --back/dismiss--> BREAK
 *   RESULT (turn over) --result_done--> BREAK  (offer keep-playing / back to Claude Code)
 *   BREAK --continue_play--> ACTIVE(free play, chains) ;  BREAK --stop_play--> IDLE
 *   any --ws close--> DISCONNECTED
 *
 * There is no countdown/timeout: questions wait for the player. Each question tracks `questionStartedAt`
 * so the UI can show a count-up chronometer and report the exact time spent. `round` advances only when
 * the player answers or skips (deterministic drill per (baseSeed, round) via deriveRoundSeed).
 */

import type { Difficulty, Outcome, ServerMessage } from '../src/shared/protocol.js';
import { deriveRoundSeed } from '../src/shared/rng.js';

export type FsmPhase = 'DISCONNECTED' | 'IDLE' | 'ACTIVE' | 'RESOLVING' | 'RESULT' | 'BREAK';

export interface FsmState {
  phase: FsmPhase;
  /** Whether Claude's turn is currently in flight (independent of the drill lifecycle). */
  turnActive: boolean;
  /** Player chose to keep training after Claude finished. */
  freePlay: boolean;
  /** Per-turn base seed from the daemon (or a local one for cold free play). */
  baseSeed: number | null;
  /** Drill index within the run (0-based); advances on answer/skip, never on a timer. */
  round: number;
  /** Seed for the drill on screen = deriveRoundSeed(baseSeed, round). */
  challengeSeed: number | null;
  /** When Claude's turn started (for the "working for m:ss" banner). */
  turnStartedAt: number | null;
  /** When the current question mounted (for the per-question count-up chronometer). */
  questionStartedAt: number | null;
  difficulty: Difficulty;
  /** True once turn_end arrived while a question was up (drives the "Claude finished" banner). */
  agentDone: boolean;
  lastOutcome: Outcome | null;
  /** Time spent on the question just answered, ms (frozen on the RESULT screen). */
  lastMs: number | null;
}

export type FsmAction =
  | { kind: 'ws_open' }
  | { kind: 'ws_close' }
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'resolve'; outcome: Outcome; ms: number }
  | { kind: 'skip' }
  | { kind: 'dismiss' }
  | { kind: 'result_done' }
  | { kind: 'continue_play' }
  | { kind: 'stop_play' };

export interface FsmCtx {
  now: number;
}

export const initialFsmState: FsmState = {
  phase: 'DISCONNECTED',
  turnActive: false,
  freePlay: false,
  baseSeed: null,
  round: 0,
  challengeSeed: null,
  turnStartedAt: null,
  questionStartedAt: null,
  difficulty: 'med',
  agentDone: false,
  lastOutcome: null,
  lastMs: null,
};

/** Mount the first question of a real Claude turn (late-joiner safe: always starts at round 0). */
function mountTurn(
  baseSeed: number,
  turnStartedAt: number,
  difficulty: Difficulty,
  now: number,
): FsmState {
  return {
    ...initialFsmState,
    phase: 'ACTIVE',
    turnActive: true,
    baseSeed,
    round: 0,
    challengeSeed: deriveRoundSeed(baseSeed, 0),
    turnStartedAt,
    questionStartedAt: now,
    difficulty,
  };
}

/** Advance to the next question (busy-turn chaining, free play, BREAK->continue). No timer involved. */
function nextRound(state: FsmState, now: number, freePlay: boolean): FsmState {
  const baseSeed = state.baseSeed ?? now % 0x7fffffff;
  const round = state.round + 1;
  return {
    ...state,
    phase: 'ACTIVE',
    freePlay,
    baseSeed,
    round,
    challengeSeed: deriveRoundSeed(baseSeed, round),
    questionStartedAt: now,
    agentDone: false,
    lastOutcome: null,
    lastMs: null,
  };
}

function toBreak(state: FsmState): FsmState {
  return {
    ...initialFsmState,
    phase: 'BREAK',
    baseSeed: state.baseSeed,
    round: state.round,
    difficulty: state.difficulty,
  };
}

export function fsmReduce(state: FsmState, action: FsmAction, ctx: FsmCtx): FsmState {
  switch (action.kind) {
    case 'ws_close':
      return { ...initialFsmState, phase: 'DISCONNECTED' };

    case 'ws_open':
      return state; // wait for hello

    case 'server': {
      const msg = action.msg;
      switch (msg.type) {
        case 'hello':
          if (msg.turn && msg.turn.status === 'BUSY') {
            return mountTurn(
              msg.turn.gameSeed,
              msg.turn.turnStartedAt,
              msg.turn.difficulty,
              ctx.now,
            );
          }
          return { ...initialFsmState, phase: 'IDLE' };

        case 'turn_start':
          // A real Claude turn always takes over (also ends any free-play run).
          return mountTurn(msg.gameSeed, msg.turnStartedAt, msg.difficulty, ctx.now);

        case 'turn_end':
          // Mid-question? Keep it up (RESOLVING) — never yank; the chronometer keeps running.
          if (state.phase === 'ACTIVE') {
            return {
              ...state,
              phase: 'RESOLVING',
              turnActive: false,
              agentDone: true,
            };
          }
          if (state.phase === 'RESOLVING') return { ...state, turnActive: false, agentDone: true };
          if (state.phase === 'RESULT') return { ...state, turnActive: false, agentDone: true };
          return state.phase === 'BREAK' ? state : { ...initialFsmState, phase: 'IDLE' };

        case 'heartbeat':
        case 'stats_update':
          return state;

        default:
          return state;
      }
    }

    case 'resolve':
      if (state.phase === 'ACTIVE' || state.phase === 'RESOLVING') {
        return {
          ...state,
          phase: 'RESULT',
          lastOutcome: action.outcome,
          lastMs: action.ms,
        };
      }
      return state;

    case 'skip':
      if (state.phase === 'ACTIVE') return nextRound(state, ctx.now, state.freePlay);
      return state;

    case 'dismiss':
      // Leaving a leftover question is a stop point with a continue offer, not a dead end.
      if (state.phase === 'RESOLVING') return toBreak(state);
      return state;

    case 'result_done': {
      if (state.phase !== 'RESULT') return state;
      if (state.turnActive || state.freePlay) return nextRound(state, ctx.now, state.freePlay);
      return toBreak(state); // turn over: offer keep-playing / back to Claude Code
    }

    case 'continue_play':
      if (state.phase === 'BREAK') return nextRound(state, ctx.now, true);
      return state;

    case 'stop_play':
      if (
        state.phase === 'BREAK' ||
        state.phase === 'ACTIVE' ||
        state.phase === 'RESOLVING' ||
        state.phase === 'RESULT'
      ) {
        return { ...initialFsmState, phase: 'IDLE' };
      }
      return state;

    default:
      return state;
  }
}
