/**
 * Shared constants. Kept free of runtime imports so both the Node daemon and the browser UI can import
 * these safely.
 */

import type { GameMode } from './protocol.js';

/** Default daemon port (ARCHITECTURE §7). Overridable via `--port`, persisted to config.json. */
export const DEFAULT_PORT = 9999;

/** Loopback bind address. NEVER 0.0.0.0 (invariant #4). */
export const BIND_HOST = '127.0.0.1';

/** Watchdog: BUSY + no event for this long (no Stop) => mark stale, end the turn (ARCHITECTURE §3). */
export const STALE_MS = 120_000;

/**
 * When `--exit-when-idle` is on: after the last Claude Code session ends, wait this long before shutting
 * the daemon down. The grace window bridges quick session restarts (a new session cancels the shutdown).
 */
export const IDLE_SHUTDOWN_MS = 20_000;

/** How often the daemon broadcasts a heartbeat with elapsedMs while BUSY. */
export const HEARTBEAT_MS = 1_000;

/**
 * Uniform drill window. Rounds inside a turn are ROUND_MS long for every game kind, which keeps the
 * cross-tab round math (turnStartedAt + r * ROUND_MS) simple and deterministic.
 */
export const ROUND_MS = 20_000;

/** Per-mode default challenge deadlines (GAMES.md; legacy modes kept for reference). */
export const DEFAULT_DEADLINE_MS: Record<GameMode, number> = {
  mcq: 20_000,
  code: 20_000,
  'bug-hunt': 15_000,
  'big-o': 12_000,
  syntax: 20_000,
};

/** How long the RESULT screen lingers before returning to IDLE. */
export const RESULT_LINGER_MS = 2_500;

/** Rolling-accuracy ring buffer size per mode (GAMES.md difficulty ramp). */
export const ROLLING_ACCURACY_CAP = 20;

/** Capped stats history length (GAMES.md). */
export const HISTORY_CAP = 200;

/** Fallback emitter socket write timeout. MUST stay tiny — never block Claude Code (invariant #1). */
export const EMIT_TIMEOUT_MS = 50;

/** Stable marker used to tag CWCC-owned settings.json hook entries so uninstall can find them. */
export const HOOK_TAG = 'cwcc';
