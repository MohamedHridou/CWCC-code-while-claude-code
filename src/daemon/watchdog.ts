/**
 * Watchdog: scan the session map and return the ids of BUSY sessions that have gone silent past
 * STALE_MS with no Stop (a crashed/killed session may never send Stop). ARCHITECTURE §3, §10.
 * Pure — the server runs it on an interval and broadcasts turn_end{reason:"stale"} for each.
 */

import type { SessionState } from '../shared/protocol.js';
import { isStale } from './session-state.js';

export function findStaleSessions(
  sessions: Iterable<SessionState>,
  now: number,
  staleMs: number,
): string[] {
  const stale: string[] = [];
  for (const s of sessions) {
    if (isStale(s, now, staleMs)) stale.push(s.sessionId);
  }
  return stale;
}
