/**
 * TESTING Layer 2 — a REAL daemon on an ephemeral port driven by fake-claude sequences, asserted on
 * both HTTP responses and the broadcast WS stream. Fast timers via injected staleMs/heartbeatMs.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { ensureToken } from '../../src/shared/token.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import { event, postEvent, sleep } from './fake-claude.js';

let daemon: DaemonHandle;
let port = 0;
let token = '';

interface Tap {
  messages: ServerMessage[];
  close: () => void;
  waitFor: (pred: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
}

function connectTap(): Promise<Tap> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: { Origin: 'http://localhost' },
    });
    const messages: ServerMessage[] = [];
    const tap: Tap = {
      messages,
      close: () => ws.close(),
      waitFor: (pred, timeoutMs = 2000) =>
        new Promise((res, rej) => {
          const found = messages.find(pred);
          if (found) return res(found);
          const t = setTimeout(
            () => rej(new Error(`waitFor timed out; saw: ${JSON.stringify(messages)}`)),
            timeoutMs,
          );
          const iv = setInterval(() => {
            const m = messages.find(pred);
            if (m) {
              clearTimeout(t);
              clearInterval(iv);
              res(m);
            }
          }, 10);
        }),
    };
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    ws.on('open', () => resolve(tap));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'cwcc-itest-'));
  token = ensureToken();
  daemon = startDaemon({
    port: 0,
    staleMs: 300,
    heartbeatMs: 100,
    watchdogMs: 50,
  });
  ({ port } = await daemon.ready);
});

afterAll(async () => {
  await daemon.close();
});

describe('event window (real daemon + fake-claude)', () => {
  it('rejects a missing/bad token with 401 and never a 500', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/event`, {
      method: 'POST',
      headers: { 'X-CWCC-Token': 'wrong' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a WS upgrade with a bad token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad`);
        ws.on('open', resolve);
        ws.on('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('normal turn: start -> heartbeats -> subagent guard -> stop', async () => {
    const tap = await connectTap();
    await tap.waitFor((m) => m.type === 'hello');
    await tap.waitFor((m) => m.type === 'stats_update');

    expect(await postEvent(port, token, event('UserPromptSubmit', 'it-1'))).toBe(204);
    const start = await tap.waitFor((m) => m.type === 'turn_start');
    expect(start.type === 'turn_start' && start.difficulty).toBe('med');

    await tap.waitFor((m) => m.type === 'heartbeat'); // 100ms cadence

    // Subagent stop mid-turn MUST NOT end the turn.
    await postEvent(port, token, event('SubagentStop', 'it-1', { agent_id: 'a1' }));
    await sleep(150);
    expect(tap.messages.some((m) => m.type === 'turn_end')).toBe(false);

    await postEvent(port, token, event('Stop', 'it-1'));
    const end = await tap.waitFor((m) => m.type === 'turn_end');
    expect(end.type === 'turn_end' && end.reason).toBe('stop');
    tap.close();
  });

  it('a queued UserPromptSubmit mid-turn does not restart or re-seed the turn', async () => {
    const tap = await connectTap();
    await postEvent(port, token, event('UserPromptSubmit', 'it-2'));
    const first = await tap.waitFor((m) => m.type === 'turn_start');
    const starts = () => tap.messages.filter((m) => m.type === 'turn_start').length;
    const before = starts();
    await postEvent(port, token, event('UserPromptSubmit', 'it-2'));
    await sleep(150);
    expect(starts()).toBe(before); // no second broadcast
    expect(first.type === 'turn_start' && first.gameSeed).toBeGreaterThan(0);
    await postEvent(port, token, event('Stop', 'it-2'));
    await tap.waitFor((m) => m.type === 'turn_end');
    tap.close();
  });

  it('late joiner: hello carries BUSY turn with server-computed elapsedMs', async () => {
    await postEvent(port, token, event('UserPromptSubmit', 'it-3'));
    await sleep(150);
    const tap = await connectTap();
    const hello = await tap.waitFor((m) => m.type === 'hello');
    if (hello.type !== 'hello' || !hello.turn) throw new Error('expected BUSY hello');
    expect(hello.turn.status).toBe('BUSY');
    expect(hello.turn.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(hello.turn.gameSeed).toBeGreaterThan(0);
    await postEvent(port, token, event('Stop', 'it-3'));
    await tap.waitFor((m) => m.type === 'turn_end');
    tap.close();
  });

  it('two sessions: active = most recently BUSY; ending it promotes the other', async () => {
    const tap = await connectTap();
    await postEvent(port, token, event('UserPromptSubmit', 'it-A'));
    await tap.waitFor((m) => m.type === 'turn_start' && m.sessionId === 'it-A');
    await postEvent(port, token, event('UserPromptSubmit', 'it-B'));
    await tap.waitFor((m) => m.type === 'turn_start' && m.sessionId === 'it-B');

    await postEvent(port, token, event('Stop', 'it-B'));
    await tap.waitFor((m) => m.type === 'turn_end' && m.sessionId === 'it-B');
    // Promotion: it-A is still BUSY and becomes active again.
    const promoted = await tap.waitFor(
      (m, idx = tap.messages.indexOf(m)) =>
        m.type === 'turn_start' &&
        m.sessionId === 'it-A' &&
        idx > tap.messages.findIndex((x) => x.type === 'turn_end' && x.sessionId === 'it-B'),
    );
    expect(promoted.type).toBe('turn_start');
    await postEvent(port, token, event('Stop', 'it-A'));
    await tap.waitFor((m) => m.type === 'turn_end' && m.sessionId === 'it-A');
    tap.close();
  });

  it('watchdog ends a silent BUSY session with reason "stale"', async () => {
    const tap = await connectTap();
    await postEvent(port, token, event('UserPromptSubmit', 'it-crash'));
    await tap.waitFor((m) => m.type === 'turn_start' && m.sessionId === 'it-crash');
    // 300ms staleMs + 50ms watchdog: silence then stale turn_end.
    const end = await tap.waitFor((m) => m.type === 'turn_end' && m.sessionId === 'it-crash', 2000);
    expect(end.type === 'turn_end' && end.reason).toBe('stale');
    tap.close();
  });

  it('challenge_result over WS is validated, persisted, and re-broadcast as stats_update', async () => {
    const tap = await connectTap();
    await tap.waitFor((m) => m.type === 'hello');
    const raw = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
      headers: { Origin: 'http://localhost' },
    });
    await new Promise((r) => raw.on('open', r));
    raw.send(
      JSON.stringify({
        type: 'challenge_result',
        mode: 'bug-hunt',
        outcome: 'solved',
        ms: 3200,
        seed: 42,
      }),
    );
    const upd = await tap.waitFor((m) => m.type === 'stats_update' && m.totalSolved >= 1);
    expect(upd.type === 'stats_update' && upd.streak).toBeGreaterThanOrEqual(1);
    // An invalid message is dropped without killing the connection.
    raw.send(
      JSON.stringify({
        type: 'challenge_result',
        mode: 'chess',
        outcome: 'solved',
        ms: 1,
        seed: 1,
      }),
    );
    await sleep(100);
    expect(raw.readyState).toBe(WebSocket.OPEN);
    raw.close();
    tap.close();
  });

  it('cold start: a POST to a dead port fails fast and throws nothing unhandled', async () => {
    const t0 = Date.now();
    await expect(
      fetch(`http://127.0.0.1:1/api/event`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('serves the UI with hardening headers and no-store on the token-bearing index', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('__CWCC__');
    expect(html).toMatch(/nonce="/);
  });
});

describe('idle-shutdown (exit-when-idle)', () => {
  it('shuts down after the last session ends; a new session cancels a pending shutdown', async () => {
    let shutdowns = 0;
    const d = startDaemon({
      port: 0,
      staleMs: 60_000,
      watchdogMs: 60_000,
      exitWhenIdle: true,
      idleShutdownMs: 150,
      onIdleShutdown: () => {
        shutdowns++;
      },
    });
    const { port: p } = await d.ready;

    // Session A opens and closes → arms the grace timer.
    await postEvent(p, token, event('UserPromptSubmit', 'A'));
    await postEvent(p, token, event('Stop', 'A'));
    await postEvent(p, token, event('SessionEnd', 'A'));

    // A new session B appears inside the grace window → cancels the shutdown.
    await sleep(60);
    await postEvent(p, token, event('UserPromptSubmit', 'B'));
    await sleep(220);
    expect(shutdowns).toBe(0);

    // End B → after the grace period, the daemon shuts down (exactly once).
    await postEvent(p, token, event('SessionEnd', 'B'));
    await sleep(260);
    expect(shutdowns).toBe(1);

    await d.close();
  });

  it('a fresh, never-used daemon never idle-shuts-down', async () => {
    let shutdowns = 0;
    const d = startDaemon({
      port: 0,
      exitWhenIdle: true,
      idleShutdownMs: 80,
      onIdleShutdown: () => {
        shutdowns++;
      },
    });
    await d.ready;
    await sleep(200);
    expect(shutdowns).toBe(0); // it never saw a session, so it stays up
    await d.close();
  });
});
