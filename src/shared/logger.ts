/**
 * File logger. Invariant #6: fail silently outward, log verbosely inward.
 *
 * CWCC MUST NOT write to stdout/stderr on the hook path (that could surface into Claude Code). All logs
 * go to `~/.claude/cwcc/logs/`. Logging itself must never throw.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from './paths.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

let ensured = false;
let cachedDay = '';
let cachedFile = '';

function ensureDir(): void {
  if (ensured) return;
  try {
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    ensured = true;
  } catch {
    // Swallow — logging must never throw and never surface outward.
  }
}

function logFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== cachedDay) {
    cachedDay = day;
    cachedFile = join(logsDir(), `${day}.log`);
  }
  return cachedFile;
}

function line(level: Level, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const suffix = meta ? ' ' + safeJson(meta) : '';
  return `${ts} [${level.toUpperCase()}] ${msg}${suffix}\n`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<unserializable>"';
  }
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  ensureDir();
  try {
    appendFileSync(logFile(), line(level, msg, meta));
  } catch {
    // Never throw from the log path.
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
