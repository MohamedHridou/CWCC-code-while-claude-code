/**
 * WebSocket client: connects to ws://127.0.0.1:PORT/ws?token=..., feeds ServerMessages to a handler,
 * sends ClientMessages, and auto-reconnects. ARCHITECTURE §4.2. The token + port are injected by the
 * daemon into `window.__CWCC__` (see daemon/static.ts).
 */

import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

interface CwccBootConfig {
  token: string;
  port: number;
}

declare global {
  interface Window {
    __CWCC__?: CwccBootConfig;
  }
}

export interface WsClient {
  send: (msg: ClientMessage) => void;
}

export interface WsHandlers {
  onOpen: () => void;
  onClose: () => void;
  onMessage: (msg: ServerMessage) => void;
}

export function connect(handlers: WsHandlers): WsClient {
  const cfg = window.__CWCC__;
  const port = cfg?.port ?? (Number(location.port) || 9999);
  const token = cfg?.token ?? '';
  const url = `ws://${location.hostname}:${port}/ws?token=${encodeURIComponent(token)}`;

  let ws: WebSocket | null = null;
  let reconnectMs = 500;
  let closedByUs = false;

  function open(): void {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      reconnectMs = 500;
      handlers.onOpen();
      send({ type: 'subscribe' });
    });
    ws.addEventListener('message', (ev) => {
      try {
        handlers.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener('close', () => {
      handlers.onClose();
      if (!closedByUs) {
        setTimeout(open, reconnectMs);
        reconnectMs = Math.min(reconnectMs * 2, 5000);
      }
    });
    ws.addEventListener('error', () => ws?.close());
  }

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  open();
  window.addEventListener('beforeunload', () => {
    closedByUs = true;
    ws?.close();
  });

  return { send };
}
