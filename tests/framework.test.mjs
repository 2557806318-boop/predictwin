import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { units, decimal, ceilDiv } from '../src/money.mjs';
import { MarketData, validateBooks } from '../src/market-data.mjs';
import { CheckpointScheduler } from '../src/checkpoints.mjs';
import { TokenBucket } from '../src/rate-limit.mjs';
import { createCachedLookup } from '../src/http-transport.mjs';
import { validateQuote } from '../src/quote.mjs';
import { SyntheticProvider } from '../src/adapters.mjs';
import { Store } from '../src/store.mjs';
import { PaperEngine } from '../src/engine.mjs';
import { decide } from '../src/strategy.mjs';
import { serve } from '../src/server.mjs';

const round = { roundId: 'test-round', asset: 'DEMO', targetPrice: '100', endTimeMs: 300000 };
const candidate = () => ({ action: 'CANDIDATE', side: 'UP', budgetWei: units('5'), probabilityLower: '0.8', minEdge: '0.01' });
const request = () => ({ ...candidate(), roundId: round.roundId, nowMs: 100000 });
const features = { sourceAgeMs: 0 };
const provider = new SyntheticProvider();
function fixture(t, options = {}) {
  const store = new Store();
  t.after(() => store.close());
  return { store, engine: new PaperEngine({ store, provider, strategy: candidate, now: () => 100000, ...options }) };
}

test('exact money: decimal round trip and smallest unit', () => {
  assert.equal(decimal(units('0.000000000000000001')), '0.000000000000000001');
  assert.equal(decimal(units('-123.456')), '-123.456');
  assert.equal(decimal(units('100')), '100');
  assert.equal(units('0.1') + units('0.2'), units('0.3'));
  assert.equal(ceilDiv(5n, 2n), 3n);
});
test('reject numeric monetary input and unsupported precision', () => {
  for (const value of [0.1, 'NaN', '1e3', '1.0000000000000000001', '']) assert.throws(() => units(value));
  assert.throws(() => ceilDiv(1n, 0n));
});
test('default strategy cannot trade', () => assert.equal(decide({}).action, 'SKIP'));
test('market data rejects duplicate, out of order and future ticks', () => {
  const data = new MarketData();
  const tick = { asset: 'DEMO', price: '100.1', sourceTimeMs: 1000, receivedTimeMs: 1000 };
  assert.equal(data.ingest(tick), true);
  assert.equal(data.ingest(tick), false);
  assert.equal(data.ingest({ ...tick, sourceTimeMs: 999 }), false);
  assert.equal(data.ingest({ ...tick, sourceTimeMs: 1001 }), false);
  assert.equal(data.features(round, 999), null);
  assert.equal(data.features(round, 1000).price, '100.1');
});
test('bounded windows and no future receive-time leakage', () => {
  const data = new MarketData({ maxTicks: 2 });
  for (const t of [1000, 1100, 1200]) data.ingest({ asset: 'DEMO', price: '100', sourceTimeMs: t, receivedTimeMs: t + 100 });
  assert.equal(data.features(round, 1250).windows[3].count, 1);
  assert.equal(data.features(round, 1300).windows[3].count, 2);
});
test('checkpoint triggers once and does not create entries', () => {
  const scheduler = new CheckpointScheduler([180], 1000);
  assert.equal(scheduler.due(round, 120000), 180);
  assert.equal(scheduler.due(round, 120100), null);
  assert.equal(scheduler.hasFired(round.roundId, 180), true);
  scheduler.prune([]);
  assert.equal(scheduler.hasFired(round.roundId, 180), false);
});
test('dual book validation: age, identity, divergence and crossed book', async () => {
  const [a, b] = await provider.books(request());
  const opts = { ...request(), nowMs: 100000 };
  assert.equal(validateBooks(a, b, opts), null);
  assert.equal(validateBooks(a, { ...b, observedAtMs: 100001 }, opts), 'BOOK_STALE');
  assert.equal(validateBooks(a, { ...b, side: 'DOWN' }, opts), 'BOOK_IDENTITY_MISMATCH');
  assert.equal(validateBooks(a, { ...b, asks: [{ price: '0.7', shares: '100' }] }, opts), 'BOOK_DIVERGENCE');
  assert.equal(validateBooks(a, { ...b, bids: [{ price: '0.6', shares: '100' }] }, opts), 'BOOK_CROSSED');
});
test('quote includes fee exactly once and binds actual amount', async () => {
  const req = request();
  const q = await provider.quote(req);
  const result = validateQuote(q, req, 100000);
  assert.equal(result.ok, true);
  assert.ok(result.effectiveCost > units('0.5'));
  assert.equal(validateQuote(q, { ...req, budgetWei: units('10') }, 100000).reason, 'QUOTE_AMOUNT_MISMATCH');
});
test('quote rejects expiry, mismatched side, no edge and inconsistent cost', async () => {
  const req = request();
  const q = await provider.quote(req);
  assert.equal(validateQuote(q, req, q.expireAtMs).reason, 'QUOTE_EXPIRED');
  assert.equal(validateQuote({ ...q, side: 'DOWN' }, req, 100000).reason, 'QUOTE_IDENTITY');
  assert.equal(validateQuote(q, { ...req, probabilityLower: '0.4' }, 100000).reason, 'NO_NET_EDGE');
  assert.equal(validateQuote({ ...q, averagePrice: '0.6' }, req, 100000).reason, 'QUOTE_COST_INCONSISTENT');
});
test('paper fill debits shared cash and blocks second order in round', async t => {
  const { store, engine } = fixture(t);
  assert.equal((await engine.evaluate(round, features)).state, 'PAPER_FILLED');
  assert.equal(store.available(), units('95'));
  assert.equal((await engine.evaluate(round, features)).reason, 'ROUND_ALREADY_FILLED');
  assert.equal(store.trades().length, 1);
});
test('cash update rolls back on failed direct fill', async t => {
  const { store } = fixture(t);
  const req = { ...request(), budgetWei: units('200') };
  const q = await provider.quote(req);
  assert.throws(() => store.fill(round, req, q, 100000), /INSUFFICIENT/);
  assert.equal(store.available(), units('100'));
  assert.equal(store.trades().length, 0);
});
for (const label of ['UP', 'DOWN']) {
  test(`settlement ${label}: atomic and idempotent`, async t => {
    const { store, engine } = fixture(t);
    await engine.evaluate(round, features);
    assert.equal(store.settle(round.roundId, label), true);
    assert.equal(store.settle(round.roundId, label), false);
    assert.equal(store.available(), units(label === 'UP' ? '104.9' : '95'));
    assert.equal(BigInt(store.trades()[0].pnl), units(label === 'UP' ? '4.9' : '-5'));
  });
}
test('flat settlement needs explicit rule', async t => {
  const { store, engine } = fixture(t);
  await engine.evaluate(round, features);
  assert.throws(() => store.settle(round.roundId, 'FLAT'), /FLAT_RULE/);
  store.settle(round.roundId, 'FLAT', 'REFUND');
  assert.equal(store.available(), units('100'));
});
test('empty strategy does not request books or quotes', async t => {
  const badProvider = { books: () => { throw new Error('Should not call'); } };
  const { engine } = fixture(t, { strategy: decide, provider: badProvider });
  assert.equal((await engine.evaluate(round, features)).reason, 'STRATEGY_NOT_IMPLEMENTED_OR_SKIPPED');
});
test('allocation cap enforced before provider calls', async t => {
  const { engine } = fixture(t, { strategy: () => ({ ...candidate(), budgetWei: units('20') }) });
  assert.equal((await engine.evaluate(round, features)).reason, 'PAPER_ALLOCATION_LIMIT');
});
test('stale data never enters quote path', async t => {
  const { engine } = fixture(t);
  assert.equal((await engine.evaluate(round, { sourceAgeMs: 5000 })).reason, 'SOURCE_STALE');
  assert.equal((await engine.evaluate(round, { sourceAgeMs: NaN })).reason, 'SOURCE_STALE');
  assert.equal((await engine.evaluate(round, {})).reason, 'SOURCE_STALE');
});
test('exact amount: one quote, rejected quote is never resized/retried', async t => {
  let calls = 0;
  const custom = { books: r => provider.books(r), quote: async r => {
    calls++; assert.equal(r.budgetWei, units('5'));
    return { ...await provider.quote(r), totalDebitWei: units('10') };
  } };
  const { engine, store } = fixture(t, { provider: custom });
  assert.equal((await engine.evaluate(round, features)).reason, 'QUOTE_AMOUNT_MISMATCH');
  assert.equal(calls, 1); assert.equal(store.available(), units('100'));
});
test('timeout ignores late provider response and releases pipeline lock', async t => {
  let resolve;
  const slow = { books: r => provider.books(r), quote: () => new Promise(r => { resolve = r; }) };
  const { engine, store } = fixture(t, { provider: slow, timeoutMs: 10 });
  assert.equal((await engine.evaluate(round, features)).reason, 'PIPELINE_ERROR_OR_TIMEOUT');
  resolve(await provider.quote(request()));
  await new Promise(r => setImmediate(r));
  assert.equal(store.available(), units('100'));
  assert.equal(engine.inFlight, false);
});
test('concurrent candidates do not spend the same cash', async t => {
  const { engine, store } = fixture(t);
  const results = await Promise.all([engine.evaluate(round, features), engine.evaluate({ ...round, roundId: 'other' }, features)]);
  assert.equal(results.filter(r => r.state === 'PAPER_FILLED').length, 1);
  assert.equal(results.filter(r => r.reason === 'PIPELINE_BUSY').length, 1);
  assert.equal(store.available(), units('95'));
});
test('latency survives restart with sample count and interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framework-test-'));
  try {
    const path = join(dir, 'test.sqlite');
    let store = new Store(path);
    store.recordLatency('quoteRtt', 10, 1000); store.recordLatency('quoteRtt', 30, 2000);
    store.close(); store = new Store(path);
    try {
      const m = store.latencySummary().metrics.quoteRtt;
      assert.equal(m.count, 2); assert.equal(m.p50, 20); assert.equal(m.fromMs, 1000); assert.equal(m.toMs, 2000);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('refuses unrelated existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'framework-test-'));
  try {
    const path = join(dir, 'other.sqlite');
    const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(id INTEGER)'); db.close();
    assert.throws(() => new Store(path), /REFUSE_EXISTING/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('token bucket validates weights, wait budget and cancellation', async () => {
  const bucket = new TokenBucket(1);
  await bucket.acquire(1);
  await assert.rejects(bucket.acquire(1, { maxWaitMs: 0 }), /UNAVAILABLE/);
  await assert.rejects(bucket.acquire(-1), /Invalid/);
  await assert.rejects(bucket.acquire(1, { signal: AbortSignal.abort() }));
  assert.throws(() => new TokenBucket(0));
});
test('DNS cache coalesces requests without pinning expired entries', async () => {
  let count = 0, now = 0;
  const lookup = createCachedLookup({ ttlMs: 10, now: () => now, lookup: (_host, _opts, done) => {
    count++; queueMicrotask(() => done(null, '127.0.0.1', 4));
  } });
  const resolve = () => new Promise((ok, fail) => lookup('localhost', {}, (e, a) => e ? fail(e) : ok(a)));
  await Promise.all([resolve(), resolve()]); assert.equal(count, 1);
  now = 11; await resolve(); assert.equal(count, 2);
});
test('HTTP endpoints read only and default loopback', async t => {
  const { store } = fixture(t);
  const server = serve(store, () => ({ source: 'SYNTHETIC' }), 0);
  await once(server, 'listening');
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await fetch(`${base}/api/status`)).json()).mode, 'PAPER_ONLY');
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/live`)).status, 404);
    assert.match(await (await fetch(base)).text(), /SYNTHETIC DATA/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
