/**
 * Per-OS filesystem locations for CWCC. See ARCHITECTURE §8.
 *
 * All runtime state lives under `~/.claude/cwcc/`. settings.json lives at `~/.claude/settings.json`
 * (POSIX) / `%USERPROFILE%\.claude\settings.json` (Windows) — both expand from os.homedir().
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the home dir. POSIX semantics prefer $HOME (matching libuv), read from the JS-side env so
 * overrides work in worker_threads too (vitest's thread pool copies env per-thread; os.homedir()
 * would read the process-level environ and ignore the override). Windows: HOME is normally unset,
 * so this falls through to os.homedir() (%USERPROFILE%).
 */
function home(): string {
  const h = process.env.HOME;
  return h && h.length > 0 ? h : homedir();
}

/** `~/.claude` */
export function claudeDir(): string {
  return join(home(), '.claude');
}

/** `~/.claude/settings.json` — the file the installer mutates (merge-only, backed up). */
export function settingsPath(): string {
  return join(claudeDir(), 'settings.json');
}

/** Backup written verbatim before the first mutation (only if none exists yet). */
export function settingsBackupPath(): string {
  return join(claudeDir(), 'settings.json.cwcc.bak');
}

/** `~/.claude/cwcc` — all CWCC runtime data. */
export function cwccDir(): string {
  return join(claudeDir(), 'cwcc');
}

/** 32-byte install token, stored 0600 (ARCHITECTURE §7). */
export function tokenPath(): string {
  return join(cwccDir(), 'token');
}

/** Persisted config (chosen port, hook mode, etc.) so hooks and UI agree. */
export function configPath(): string {
  return join(cwccDir(), 'config.json');
}

/** Companion record of installed hook entries, for surgical uninstall. */
export function installedRecordPath(): string {
  return join(cwccDir(), 'installed.json');
}

/** Local stats/streak store (GAMES.md schema). */
export function statsPath(): string {
  return join(cwccDir(), 'stats.json');
}

/** Daemon PID file, written on `cwcc start`, used by `cwcc stop`/`status`. */
export function pidPath(): string {
  return join(cwccDir(), 'daemon.pid');
}

/** Log directory. Nothing CWCC does surfaces to Claude Code — it goes here (invariant #6). */
export function logsDir(): string {
  return join(cwccDir(), 'logs');
}
