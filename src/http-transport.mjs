import dns from 'node:dns';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { quantile } from './utils.mjs';

// Short-lived DNS cache, not a pinned exchange IP. Preserve family/all semantics
// and never cache failures. TLS hostname validation remains unchanged.
export function createCachedLookup({ lookup = dns.lookup, ttlMs = 30_000, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  return (hostname, options, callback) => {
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    const key = JSON.stringify([hostname, opts.family || 0, opts.hints || 0,
      Boolean(opts.all), opts.order ?? opts.verbatim ?? null]);
    const cached = cache.get(key);
    if (cached && now() < cached.expires) {
      queueMicrotask(() => callback(null, structuredClone(cached.address), cached.family));
      return;
    }
    if (pending.has(key)) { pending.get(key).push(callback); return; }
    pending.set(key, [callback]);
    lookup(hostname, opts, (error, address, family) => {
      if (!error) {
        if (cache.size >= 64) cache.clear();
        cache.set(key, { address: structuredClone(address), family, expires: now() + ttlMs });
      }
      const callbacks = pending.get(key);
      pending.delete(key);
      for (const done of callbacks) done(error, structuredClone(address), family);
    });
  };
}

export class PredictionHttpAgent extends https.Agent {
  #samples = [];
  constructor(lookup) {
    super({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 16,
      maxFreeSockets: 8, scheduling: 'lifo', maxCachedSessions: 100, lookup });
  }

  addRequest(request, options) {
    const started = performance.now();
    const sample = { observedAtMs: Date.now(), reused: false };
    let finished = false;
    const done = (success) => {
      if (finished) return;
      finished = true;
      sample.success = success;
      sample.totalMs = performance.now() - started;
      this.#samples.push(sample);
      if (this.#samples.length > 500) this.#samples.shift();
    };
    request.once('socket', (socket) => {
      sample.socketWaitMs = performance.now() - started;
      sample.reused = Boolean(request.reusedSocket);
      socket.setNoDelay(true);
      // Do not attach new connection listeners to reused sockets.
      if (socket.connecting) {
        socket.once('lookup', () => { sample.dnsCompleteMs = performance.now() - started; });
        socket.once('connect', () => { sample.tcpCompleteMs = performance.now() - started; });
        socket.once('secureConnect', () => { sample.tlsCompleteMs = performance.now() - started; });
      }
    });
    request.once('response', (response) => {
      sample.firstByteMs = performance.now() - started;
      sample.statusCode = response.statusCode;
      response.once('end', () => done(true));
      response.once('error', () => done(false));
      response.once('aborted', () => done(false));
    });
    request.once('error', () => done(false));
    super.addRequest(request, options);
  }

  summary() {
    const metrics = {};
    for (const name of ['socketWaitMs', 'dnsCompleteMs', 'tcpCompleteMs', 'tlsCompleteMs', 'firstByteMs', 'totalMs']) {
      const values = this.#samples.map((row) => row[name]).filter(Number.isFinite);
      metrics[name] = { count: values.length, p50: quantile(values, 0.5),
        p95: quantile(values, 0.95), p99: quantile(values, 0.99) };
    }
    return { scope: 'PROCESS_LOCAL_LAST_500_HTTP_ATTEMPTS', samples: this.#samples.length,
      measuredFromMs: this.#samples[0]?.observedAtMs ?? null,
      measuredToMs: this.#samples.at(-1)?.observedAtMs ?? null,
      reusedConnections: this.#samples.filter((row) => row.reused).length,
      failures: this.#samples.filter((row) => !row.success).length,
      // Cumulative connection milestones are diagnostic, not additive segments.
      metrics };
  }
}
