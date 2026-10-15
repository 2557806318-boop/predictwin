import { MarketData } from '../src/market-data.mjs';
import { decide } from '../src/strategy.mjs';

// Entirely fabricated ticks. Feed only information available at the decision time.
const feed = new MarketData();
const round = { roundId: 'replay-demo', asset: 'DEMO', targetPrice: '100', endTimeMs: 300000 };
for (let t = 100000; t < 101000; t += 100) {
  feed.ingest({ asset: 'DEMO', price: '100.20', sourceTimeMs: t, receivedTimeMs: t });
  const decision = decide({ round, features: feed.features(round, t), nowMs: t });
  console.log(JSON.stringify({ atMs: t, decision }));
}
console.log('No historical quote, fill or profit is inferred by this replay.');
