/**
 * PROTOCOL — the single source of truth for all wire contracts.
 *
 * Defined per ARCHITECTURE §4. Imported by the daemon, the emitter, and the web UI.
 * DO NOT redefine any of these shapes locally anywhere else.
 *
 * NOTE (Phase 1 gate): the exact field names Claude Code POSTs must be confirmed against ONE live
 * session and pinned here via the adapter. Until then, `RawClaudeEvent` is a best-effort mapping.
 */

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

/** Claude Code lifecycle events CWCC consumes. See ARCHITECTURE §3. */
export type CwccEventType =
  | 'UserPromptSubmit' // turn start
  | 'PreToolUse' // heartbeat / difficulty hint
  | 'PostToolUse' // heartbeat
  | 'PostToolBatch' // heartbeat
  | 'Stop' // turn end (top-level only)
  | 'SubagentStart' // nested work begins
  | 'SubagentStop' // nested work ends (MUST NOT end the turn)
  | 'SessionEnd'; // session gone

export type TurnStatus = 'IDLE' | 'BUSY';

/**
 * Game modes. 'mcq' (multiple-choice) and 'code' (typed answer + evaluator) are the active content
 * pipeline; the original three are kept for wire/stats compatibility.
 */
export type GameMode = 'mcq' | 'code' | 'bug-hunt' | 'big-o' | 'syntax';
export const GAME_MODES: readonly GameMode[] = ['mcq', 'code', 'bug-hunt', 'big-o', 'syntax'];

/** Content languages the player can train in (selected in the UI, persisted locally). */
export type ContentLang = 'python' | 'java';
export const CONTENT_LANGS: readonly ContentLang[] = ['python', 'java'];

export type Difficulty = 'easy' | 'med' | 'hard';

export type Outcome = 'solved' | 'failed' | 'timeout';
export const OUTCOMES: readonly Outcome[] = ['solved', 'failed', 'timeout'];

export type TurnEndReason = 'stop' | 'stale' | 'session_end';

// ---------------------------------------------------------------------------
// 4.1 HTTP event ingest — POST /api/event
// ---------------------------------------------------------------------------

/** Header carrying the install token on the ingest endpoint. */
export const TOKEN_HEADER = 'x-cwcc-token';

/** Normalized event body the daemon operates on (post-adapter). */
export interface CwccEvent {
  event: CwccEventType;
  /** From CLAUDE_SESSION_ID (fallback: hook parent PID). */
  sessionId: string;
  /** Present for subagent events; used to guard turn-end. */
  agentId: string | null;
  /** For PreToolUse; used as a difficulty hint. */
  tool: string | null;
  /** Client ms epoch (optional; the daemon stamps its own too). */
  ts?: number;
}

/**
 * The raw JSON Claude Code POSTs (stdin payload of the hook). Field names are provisional and MUST be
 * confirmed against a live session in Phase 1, then pinned. Map to `CwccEvent` in ONE adapter function
 * (`src/daemon/events.ts`); never scatter this mapping.
 */
export interface RawClaudeEvent {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  timestamp?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 4.2 WebSocket — ws://127.0.0.1:PORT/ws?token=<install token>
// ---------------------------------------------------------------------------

/** Snapshot of the active turn sent inside a `hello` for late-joiner sync. */
export interface TurnSnapshot {
  status: TurnStatus;
  turnStartedAt: number;
  /** Server-computed elapsed ms so a late tab mounts mid-turn with correct remaining time. */
  elapsedMs: number;
  gameSeed: number;
  /** Suggested difficulty for this turn, derived from rolling accuracy (GAMES.md ramp). */
  difficulty: Difficulty;
}

// --- Server -> client ------------------------------------------------------

export interface HelloMsg {
  type: 'hello';
  activeSessionId: string | null;
  turn: TurnSnapshot | null;
}

export interface TurnStartMsg {
  type: 'turn_start';
  sessionId: string;
  turnStartedAt: number;
  gameSeed: number;
  /** Suggested difficulty for this turn (GAMES.md ramp). */
  difficulty: Difficulty;
}

export interface TurnEndMsg {
  type: 'turn_end';
  sessionId: string;
  reason: TurnEndReason;
}

export interface HeartbeatMsg {
  type: 'heartbeat';
  sessionId: string;
  elapsedMs: number;
}

/** One row of recent play history, shown in the UI history panel. */
export interface RecentEntry {
  ts: number;
  mode: GameMode;
  outcome: Outcome;
  ms: number;
  itemId: string | null;
}

/** Stats snapshot pushed on connect and after each recorded challenge_result (retention loop). */
export interface StatsUpdateMsg {
  type: 'stats_update';
  streak: number;
  best: number;
  todaySolved: number;
  totalSolved: number;
  /** Most recent drills, newest first (capped small — it's a glanceable panel, not a log). */
  recent: RecentEntry[];
}

export type ServerMessage = HelloMsg | TurnStartMsg | TurnEndMsg | HeartbeatMsg | StatsUpdateMsg;

// --- Client -> server ------------------------------------------------------

export interface SubscribeMsg {
  type: 'subscribe';
}

export interface ChallengeResultMsg {
  type: 'challenge_result';
  mode: GameMode;
  outcome: Outcome;
  ms: number;
  seed: number;
  /** Bank item id, for the history panel. Optional for wire compatibility. */
  itemId?: string;
}

export interface PingMsg {
  type: 'ping';
}

export type ClientMessage = SubscribeMsg | ChallengeResultMsg | PingMsg;

/** Longest challenge duration we accept in a result (sanity bound for `ms`). */
const MAX_RESULT_MS = 3_600_000;

/**
 * Validate an untrusted client payload into a `ClientMessage`, or null. The WS peer is token-gated,
 * but defense in depth is cheap: never let an unvalidated shape reach the stats store.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'subscribe':
      return { type: 'subscribe' };
    case 'ping':
      return { type: 'ping' };
    case 'challenge_result': {
      if (!GAME_MODES.includes(m.mode as GameMode)) return null;
      if (!OUTCOMES.includes(m.outcome as Outcome)) return null;
      if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
      if (typeof m.seed !== 'number' || !Number.isInteger(m.seed)) return null;
      const itemIdOk = typeof m.itemId === 'string' && m.itemId.length > 0 && m.itemId.length <= 64;
      return {
        type: 'challenge_result',
        mode: m.mode as GameMode,
        outcome: m.outcome as Outcome,
        ms: Math.min(Math.max(0, Math.round(m.ms)), MAX_RESULT_MS),
        seed: m.seed >>> 0,
        ...(itemIdOk ? { itemId: m.itemId as string } : {}),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 4.3 Session state (in-daemon)
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string;
  status: TurnStatus;
  turnStartedAt: number | null;
  lastEventAt: number;
  lastTool: string | null;
  subagentDepth: number;
  /** Chosen at turn start, reused for the whole turn so every tab renders the same challenge. */
  gameSeed: number;
  stale: boolean;
}
