/**
 * Static UI serving. Assets are served by `sirv` (do NOT hand-roll traversal checks — §7). The single
 * exception is `index.html`, which we render per-request to inject the install token as
 * `window.__CWCC__` (so the same-origin page can open the authed WebSocket) plus a fresh CSP nonce.
 *
 * Security posture:
 *  - index.html carries the token  => `Cache-Control: no-store` so it never lands in disk cache.
 *  - strict CSP with a per-request script nonce; frame-ancestors 'none' (no embedding by other pages);
 *    nosniff + no-referrer everywhere.
 *  - hashed /assets get long-lived immutable caching (they contain no secrets).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { log } from '../shared/logger.js';

// Resolves to <repo>/web/dist from both src/daemon (tsx) and dist/daemon (built).
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface StaticOptions {
  token: string;
  port: number;
}

function csp(nonce: string, port: number): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", // the SPA injects one runtime <style> element
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function createStaticHandler(
  opts: StaticOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  // sirv scandirs WEB_DIST at construction and throws if it's missing. The daemon must never crash just
  // because the UI wasn't built (invariant #6) — if the dir is absent, fall through to the 404/500 paths.
  const webBuilt = existsSync(WEB_DIST);
  if (!webBuilt) {
    log.error('web UI not built (run `npm run build:web`) — serving API only', {
      dir: WEB_DIST,
    });
  }
  const assets = webBuilt
    ? sirv(WEB_DIST, {
        dev: false,
        etag: true,
        gzip: true,
        brotli: true,
        maxAge: 31536000,
        immutable: true,
        setHeaders: (res) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'no-referrer');
        },
      })
    : (_req: IncomingMessage, _res: ServerResponse, next: () => void) => next();

  let rawIndex: string | null = null;
  function loadRawIndex(): string | null {
    if (rawIndex !== null) return rawIndex;
    try {
      rawIndex = readFileSync(`${WEB_DIST}/index.html`, 'utf8');
    } catch (err) {
      log.error('web UI not built (run `npm run build:web`)', {
        error: String(err),
        dir: WEB_DIST,
      });
    }
    return rawIndex;
  }

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      const raw = loadRawIndex();
      if (raw === null) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('CWCC web UI not built. Run: npm run build:web');
        return;
      }
      const nonce = randomBytes(16).toString('base64');
      const boot = JSON.stringify({ token: opts.token, port: opts.port });
      const inject = `<script nonce="${nonce}">window.__CWCC__=${boot}</script>`;
      const html = raw.includes('</head>')
        ? raw.replace('</head>', `${inject}</head>`)
        : inject + raw;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', // the token is embedded — never cache to disk
        'Content-Security-Policy': csp(nonce, opts.port),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(html);
      return;
    }
    assets(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
  };
}
