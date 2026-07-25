/**
 * Install token: 32-byte random, generated once, stored 0600 at ~/.claude/cwcc/token (§7).
 * Required on /api/event (X-CWCC-Token) and the WS handshake (?token=). Node-only — never imported by
 * the browser bundle.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cwccDir, tokenPath } from './paths.js';

/** Read the token if it exists, else return null. */
export function readToken(): string | null {
  try {
    const t = readFileSync(tokenPath(), 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Return the existing token, or generate + persist (0600) a new one. */
export function ensureToken(): string {
  const existing = readToken();
  if (existing) return existing;
  mkdirSync(cwccDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(), token, { mode: 0o600 });
  return token;
}

export function tokenExists(): boolean {
  return existsSync(tokenPath());
}

/**
 * Constant-time string comparison (hash both sides so lengths always match).
 * Local-only surface, but a timing-safe check costs nothing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
