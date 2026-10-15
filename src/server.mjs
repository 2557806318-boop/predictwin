import http from 'node:http';
import { readFileSync } from 'node:fs';
import { json } from './money.mjs';

/** Loopback-only read API. No order, capital-reset or credential collection route. */
export function serve(store, getRuntime, port = 8080) {
  const page = readFileSync(new URL('../web/index.html', import.meta.url));
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); return; }
    const routes = {
      '/api/status': () => ({ ...store.status(), ...getRuntime() }),
      '/api/latency': () => store.latencySummary(),
      '/api/paper-trades': () => store.trades(),
      '/api/events': () => store.events(),
    };
    const handler = routes[req.url];
    if (!handler) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', 'application/json'); res.end(json(handler())); }
    catch { res.writeHead(500); res.end('{"error":"INTERNAL_ERROR"}'); }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
