#!/usr/bin/env node
/**
 * `cwcc-emit` — the fallback one-shot emitter for Claude Code setups that prefer a spawned command over a
 * raw curl line. ARCHITECTURE §2, invariant #1.
 *
 * HARD CONSTRAINT: it opens a socket with a <= EMIT_TIMEOUT_MS timeout and exits. It MUST NOT spawn the
 * daemon, MUST NOT sleep, MUST NOT await the daemon. If the daemon is down, the event is silently dropped.
 * Zero human-perceivable delay, always. Reads the raw hook JSON from stdin and POSTs it to /api/event.
 */

import { request } from 'node:http';
import { BIND_HOST, DEFAULT_PORT, EMIT_TIMEOUT_MS } from '../shared/constants.js';
import { TOKEN_HEADER } from '../shared/protocol.js';
import { readToken } from '../shared/token.js';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // Never wait on stdin longer than the emit budget.
    setTimeout(finish, EMIT_TIMEOUT_MS).unref();
  });
}

function parsePort(): number {
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

async function main(): Promise<void> {
  // Guarantee the process cannot hang: exit no matter what after the budget.
  const bail = setTimeout(() => process.exit(0), EMIT_TIMEOUT_MS * 2);
  bail.unref();

  const body = await readStdin();
  const token = readToken() ?? '';

  const req = request(
    {
      host: BIND_HOST,
      port: parsePort(),
      path: '/api/event',
      method: 'POST',
      timeout: EMIT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        [TOKEN_HEADER]: token,
      },
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.on('error', () => process.exit(0)); // daemon down => drop silently
  req.end(body);
}

void main();
