/**
 * fake-claude — drives the daemon with the real Claude Code event sequence (TESTING Layer 2).
 * Used by event-window.test.ts, and runnable manually to eyeball the UI without a live session:
 *
 *   npx tsx test/integration/fake-claude.ts [--port 9999]
 */

import { ensureToken } from '../../src/shared/token.js';
import type { RawClaudeEvent } from '../../src/shared/protocol.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST one raw hook payload to the daemon. Returns the HTTP status. */
export async function postEvent(
  port: number,
  token: string,
  body: RawClaudeEvent,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CWCC-Token': token },
    body: JSON.stringify(body),
  });
  return res.status;
}

export function event(
  name: string,
  sessionId: string,
  extra: Partial<RawClaudeEvent> = {},
): RawClaudeEvent {
  return { hook_event_name: name, session_id: sessionId, ...extra };
}

/** A demo turn for manual UI checks: prompt -> tools -> stop over ~20s. */
async function demoTurn(port: number, token: string): Promise<void> {
  const s = `fake-${Date.now()}`;
  console.log('turn start (UserPromptSubmit)…');
  await postEvent(port, token, event('UserPromptSubmit', s));
  await sleep(6000);
  console.log('PreToolUse Bash…');
  await postEvent(port, token, event('PreToolUse', s, { tool_name: 'Bash' }));
  await sleep(6000);
  console.log('PostToolUse…');
  await postEvent(port, token, event('PostToolUse', s, { tool_name: 'Bash' }));
  await sleep(6000);
  console.log('Stop.');
  await postEvent(port, token, event('Stop', s));
}

// Manual mode: `tsx test/integration/fake-claude.ts --port 9999`
if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const port = i !== -1 ? Number(process.argv[i + 1]) : 9999;
  demoTurn(port, ensureToken()).catch((err) => {
    console.error('fake-claude failed (is the daemon running?):', String(err));
    process.exit(1);
  });
}
