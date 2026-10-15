import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from './store.mjs';
import { MarketData } from './market-data.mjs';
import { CheckpointScheduler } from './checkpoints.mjs';
import { SyntheticProvider } from './adapters.mjs';
import { PaperEngine } from './engine.mjs';
import { decide } from './strategy.mjs';
import { serve } from './server.mjs';

const path = resolve(process.env.DATA_PATH ?? './data/demo.sqlite');
mkdirSync(dirname(path), { recursive: true });
const store = new Store(path);
const market = new MarketData();
const scheduler = new CheckpointScheduler([240, 180, 120, 75, 45, 25, 13, 8]);
const engine = new PaperEngine({ store, provider: new SyntheticProvider(), strategy: decide });
let runtime = { strategy: 'USER_EXTENSION_REQUIRED', checkpointRole: 'AUDIT_ONLY', source: 'SYNTHETIC', ticks: 0, lastDecision: null };
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const server = serve(store, () => runtime, port);
let closing = false;
let pending = Promise.resolve();
const timer = setInterval(() => {
  if (closing || engine.inFlight) return;
  pending = (async () => {
    const now = Date.now();
    const bucket = Math.floor(now / 300_000);
    const round = { roundId: `demo-${bucket}`, asset: 'DEMO', targetPrice: '100', endTimeMs: (bucket + 1) * 300_000 };
    const price = (100 + Math.sin(now / 5000) * 0.4).toFixed(4); // Synthetic display data only.
    market.ingest({ asset: 'DEMO', price, sourceTimeMs: now, receivedTimeMs: now });
    const started = performance.now();
    const features = market.features(round, now);
    store.recordLatency('receiveToFeatures', performance.now() - started);
    runtime = { ...runtime, ticks: runtime.ticks + 1, roundId: round.roundId, price, remainingSeconds: Math.floor((round.endTimeMs - now) / 1000) };
    scheduler.prune([round.roundId]);
    const checkpoint = scheduler.due(round, now);
    if (checkpoint !== null) store.audit('checkpoint', { role: 'AUDIT_ONLY', roundId: round.roundId, checkpoint, features });
    // Continuous evaluation is independent of checkpoints.
    runtime.lastDecision = await engine.evaluate(round, features);
  })().catch(() => { runtime.lastDecision = { state: 'ERROR', reason: 'DEMO_CYCLE_FAILED' }; });
}, 100);
const cleanup = setInterval(() => store.prune(Date.now() - 86_400_000), 60_000);
console.log(`Synthetic paper console: http://127.0.0.1:${port} — strategy intentionally empty; no live trading.`);
async function stop() {
  if (closing) return;
  closing = true;
  clearInterval(timer); clearInterval(cleanup);
  await pending;
  await new Promise(resolve => server.close(resolve));
  store.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
