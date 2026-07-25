/**
 * WebSocket hub. Broadcasts turn state to browser tabs and receives challenge results. ARCHITECTURE §4.2.
 *
 * Security (invariant #4, §7): the upgrade is rejected unless the `?token=` matches the install token
 * (constant-time compare) AND the Origin is null/localhost/127.0.0.1. Inbound messages are validated
 * through `parseClientMessage` before they touch anything. On connect we send `hello` with a
 * server-computed `elapsedMs` (late-joiner sync), followed by a `stats_update` snapshot.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseClientMessage,
  type ChallengeResultMsg,
  type HelloMsg,
  type ServerMessage,
  type StatsUpdateMsg,
} from '../shared/protocol.js';
import { safeEqual } from '../shared/token.js';
import { log } from '../shared/logger.js';

export interface WsHubOptions {
  token: string;
  /** Compute the current hello snapshot for a freshly-connected (possibly late-joining) tab. */
  getHello: () => HelloMsg;
  /** Current stats snapshot, sent right after hello so streak/today render immediately. */
  getStatsUpdate: () => StatsUpdateMsg;
  onChallengeResult: (result: ChallengeResultMsg) => void;
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true; // file:// / non-browser clients send none
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly opts: WsHubOptions) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Number of connected tabs — lets the daemon skip broadcasting into the void. */
  clientCount(): number {
    return this.clients.size;
  }

  /** Wire the hub to the http server's upgrade event, gated on path/token/Origin. */
  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '', 'http://127.0.0.1');
      } catch {
        return this.reject(socket, 400, 'bad request');
      }
      if (url.pathname !== '/ws') return this.reject(socket, 404, 'not found');
      if (!safeEqual(url.searchParams.get('token') ?? '', this.opts.token)) {
        return this.reject(socket, 401, 'unauthorized');
      }
      if (!originAllowed(req.headers.origin)) {
        return this.reject(socket, 403, 'forbidden origin');
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  private reject(socket: Socket, code: number, reason: string): void {
    log.warn('ws upgrade rejected', { code, reason });
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      socket.destroy();
    } catch {
      /* ignore */
    }
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    log.debug('ws client connected', { clients: this.clients.size });
    this.sendTo(ws, this.opts.getHello());
    this.sendTo(ws, this.opts.getStatsUpdate());

    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    ws.on('close', () => {
      this.clients.delete(ws);
      log.debug('ws client disconnected', { clients: this.clients.size });
    });
    ws.on('error', (err) => log.warn('ws client error', { error: String(err) }));
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) {
      log.warn('dropped invalid client message');
      return;
    }
    switch (msg.type) {
      case 'subscribe':
        this.sendTo(ws, this.opts.getHello());
        break;
      case 'ping':
        break; // liveness only; no reply defined in the protocol
      case 'challenge_result':
        this.opts.onChallengeResult(msg);
        break;
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('ws send failed', { error: String(err) });
    }
  }

  /** Broadcast a message to every connected tab. */
  broadcast(msg: ServerMessage): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        /* drop; close handler cleans up */
      }
    }
  }

  close(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}
