/**
 * cwcc-daemon entrypoint. Long-lived, bound to 127.0.0.1:PORT (invariant #4).
 *
 * - HTTP POST /api/event: token-checked ingest -> adapter -> pure session reducer -> WS broadcast.
 * - WS: broadcasts turn_start/turn_end/heartbeat/stats_update + hello (late-joiner sync).
 * - Per-session state map; active session = most recently BUSY (v1, ARCHITECTURE §5). When the active
 *   turn ends while another session is still BUSY, that session is promoted and re-broadcast so the UI
 *   keeps filling real wait time.
 * - Watchdog ends silent BUSY turns (reason:"stale"). Nothing here ever surfaces to Claude Code.
 * - Returns a handle (ready/close) so integration tests can drive a real daemon on an ephemeral port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BIND_HOST,
  DEFAULT_PORT,
  HEARTBEAT_MS,
  IDLE_SHUTDOWN_MS,
  STALE_MS,
} from '../shared/constants.js';
import {
  TOKEN_HEADER,
  type ChallengeResultMsg,
  type Difficulty,
  type HelloMsg,
  type RawClaudeEvent,
  type SessionState,
  type TurnEndReason,
} from '../shared/protocol.js';
import { log } from '../shared/logger.js';
import { ensureToken, safeEqual } from '../shared/token.js';
import { adaptEvent } from './events.js';
import { initialState, reduce } from './session-state.js';
import { createStaticHandler } from './static.js';
import { loadStats, recordResult, suggestDifficulty, toStatsUpdate } from './stats.js';
import { findStaleSessions } from './watchdog.js';
import { WsHub } from './ws.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface DaemonOptions {
  port?: number;
  /** Watchdog stale threshold; injectable so tests can compress time. */
  staleMs?: number;
  heartbeatMs?: number;
  watchdogMs?: number;
  /** When true, the daemon shuts itself down once every Claude Code session has ended. */
  exitWhenIdle?: boolean;
  /** Grace period before the idle shutdown fires; injectable so tests can compress time. */
  idleShutdownMs?: number;
  /** What to do when idle-shutdown fires (defaults to close + process.exit). Injectable for tests. */
  onIdleShutdown?: () => void;
}

export interface DaemonHandle {
  /** Resolves once listening, with the actual bound port (use port 0 for ephemeral in tests). */
  ready: Promise<{ port: number }>;
  close(): Promise<void>;
}

export function startDaemon(options: DaemonOptions | number = {}): DaemonHandle {
  const opts: DaemonOptions = typeof options === 'number' ? { port: options } : options;
  const port = opts.port ?? DEFAULT_PORT;
  const staleMs = opts.staleMs ?? STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const watchdogMs = opts.watchdogMs ?? 5_000;
  const exitWhenIdle = opts.exitWhenIdle ?? false;
  const idleShutdownMs = opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS;

  const token = ensureToken();
  const sessions = new Map<string, SessionState>();
  let activeSessionId: string | null = null;
  let activeDifficulty: Difficulty = 'med';
  // Idle-shutdown bookkeeping: a session lives in `sessions` from its first event until SessionEnd, so
  // sessions.size is the live-session count. Once it hits zero (after we've seen at least one), we arm a
  // grace timer and, if no new session appears, shut down (invariant: never kill a fresh, never-used daemon).
  let sawAnySession = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const getHello = (): HelloMsg => {
    const now = Date.now();
    const s = activeSessionId ? sessions.get(activeSessionId) : undefined;
    if (s && s.status === 'BUSY' && s.turnStartedAt !== null) {
      return {
        type: 'hello',
        activeSessionId: s.sessionId,
        turn: {
          status: 'BUSY',
          turnStartedAt: s.turnStartedAt,
          elapsedMs: now - s.turnStartedAt,
          gameSeed: s.gameSeed,
          difficulty: activeDifficulty,
        },
      };
    }
    return { type: 'hello', activeSessionId, turn: null };
  };

  const hub = new WsHub({
    token,
    getHello,
    getStatsUpdate: () => toStatsUpdate(loadStats()),
    onChallengeResult: (r: ChallengeResultMsg) => {
      const stats = recordResult(r);
      log.info('challenge result', {
        mode: r.mode,
        outcome: r.outcome,
        ms: r.ms,
        streak: stats.streak.current,
      });
      hub.broadcast(toStatsUpdate(stats));
    },
  });

  /** Make a session the active one and broadcast its turn_start (fresh or promoted). */
  function activate(s: SessionState): void {
    activeSessionId = s.sessionId;
    activeDifficulty = suggestDifficulty(loadStats(), 'mcq');
    hub.broadcast({
      type: 'turn_start',
      sessionId: s.sessionId,
      turnStartedAt: s.turnStartedAt ?? Date.now(),
      gameSeed: s.gameSeed,
      difficulty: activeDifficulty,
    });
  }

  /** End the active turn; if another session is still BUSY, promote the most recently active one. */
  function endActiveTurn(sessionId: string, reason: TurnEndReason): void {
    hub.broadcast({ type: 'turn_end', sessionId, reason });
    activeSessionId = null;
    let candidate: SessionState | null = null;
    for (const s of sessions.values()) {
      if (s.sessionId === sessionId || s.status !== 'BUSY') continue;
      if (!candidate || s.lastEventAt > candidate.lastEventAt) candidate = s;
    }
    if (candidate) {
      log.info('promoted busy session to active', {
        sessionId: candidate.sessionId,
      });
      activate(candidate);
    }
  }

  const serveStatic = createStaticHandler({ token, port });

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/api/event') {
      handleEvent(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      res.end('ok');
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
  });

  function handleEvent(req: IncomingMessage, res: ServerResponse): void {
    const header = req.headers[TOKEN_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented || !safeEqual(presented, token)) {
      res.writeHead(401).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      // Always 204 to the hook — responses are irrelevant to Claude Code (invariant #1, §4.1).
      // Content-Type is deliberately not enforced: curl's default type must not cause drops.
      res.writeHead(204).end();
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RawClaudeEvent;
        ingest(raw);
      } catch (err) {
        log.warn('dropped malformed event', { error: String(err) });
      }
    });
    req.on('error', (err) => log.warn('event request error', { error: String(err) }));
  }

  function ingest(raw: RawClaudeEvent): void {
    const ev = adaptEvent(raw);
    if (!ev) return;
    const now = Date.now();
    const prev = sessions.get(ev.sessionId) ?? initialState(ev.sessionId, now);
    const next = reduce(prev, ev, now);
    sessions.set(ev.sessionId, next);

    const started = prev.status !== 'BUSY' && next.status === 'BUSY';
    const ended = prev.status === 'BUSY' && next.status !== 'BUSY';

    log.info('event', {
      event: ev.event,
      sessionId: ev.sessionId,
      status: next.status,
      tool: ev.tool,
    });

    if (started) {
      activate(next);
    } else if (ended && ev.sessionId === activeSessionId) {
      endActiveTurn(ev.sessionId, ev.event === 'SessionEnd' ? 'session_end' : 'stop');
    }

    if (ev.event === 'SessionEnd') sessions.delete(ev.sessionId);

    sawAnySession = true;
    maybeScheduleIdleShutdown();
  }

  /**
   * Idle-shutdown gate. Arm a grace timer when the last session has ended; cancel it the moment a new
   * session appears. Only runs when `exitWhenIdle` is set, and never before the first session (so a
   * freshly auto-started daemon that hasn't been used yet is never killed).
   */
  function maybeScheduleIdleShutdown(): void {
    if (!exitWhenIdle) return;
    if (sessions.size > 0) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      return;
    }
    if (!sawAnySession || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sessions.size > 0) return; // raced with a new session
      log.info('all Claude Code sessions ended — shutting down (exit-when-idle)');
      const act = opts.onIdleShutdown ?? (() => void close().then(() => process.exit(0)));
      act();
    }, idleShutdownMs);
  }

  const heartbeat = setInterval(() => {
    if (!activeSessionId || hub.clientCount() === 0) return; // nobody listening — save the cycles
    const s = sessions.get(activeSessionId);
    if (s && s.status === 'BUSY' && s.turnStartedAt !== null) {
      hub.broadcast({
        type: 'heartbeat',
        sessionId: s.sessionId,
        elapsedMs: Date.now() - s.turnStartedAt,
      });
    }
  }, heartbeatMs);

  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const id of findStaleSessions(sessions.values(), now, staleMs)) {
      const s = sessions.get(id);
      if (!s) continue;
      sessions.set(id, {
        ...s,
        status: 'IDLE',
        turnStartedAt: null,
        stale: true,
      });
      log.warn('watchdog ended stale turn', { sessionId: id });
      if (id === activeSessionId) endActiveTurn(id, 'stale');
    }
  }, watchdogMs);

  hub.attach(server);

  const ready = new Promise<{ port: number }>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error('port in use', { host: BIND_HOST, port });
        process.stderr.write(
          `cwcc: port ${port} is already in use on ${BIND_HOST}. Is the daemon already running? ` +
            `Use a different --port.\n`,
        );
      } else {
        log.error('server error', { error: String(err) });
      }
      reject(err);
    });
    server.listen(port, BIND_HOST, () => {
      const bound = (server.address() as AddressInfo).port;
      log.info('daemon listening', { host: BIND_HOST, port: bound });
      process.stdout.write(`cwcc-daemon listening on http://${BIND_HOST}:${bound}\n`);
      process.stdout.write(`open the UI:  http://${BIND_HOST}:${bound}\n`);
      resolve({ port: bound });
    });
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      if (idleTimer) clearTimeout(idleTimer);
      hub.close();
      server.close(() => resolve());
      setTimeout(resolve, 500).unref();
    });

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { ready, close };
}

// Allow `tsx src/daemon/server.ts` / `node dist/daemon/server.js` to boot the daemon directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon().ready.catch(() => process.exit(1));
}
