import { units, ratio } from './money.mjs';

/** Bounded per-asset windows. Reject future, duplicate and out-of-order events. */
export class MarketData {
  constructor({ horizonMs = 60_000, maxTicks = 10_000 } = {}) {
    this.horizonMs = horizonMs;
    this.maxTicks = maxTicks;
    this.assets = new Map();
  }
  ingest(tick) {
    if (typeof tick.asset !== 'string' || !Number.isSafeInteger(tick.sourceTimeMs) ||
        !Number.isSafeInteger(tick.receivedTimeMs) || tick.sourceTimeMs > tick.receivedTimeMs || units(tick.price) <= 0n) return false;
    const rows = this.assets.get(tick.asset) ?? [];
    if (rows.length && tick.sourceTimeMs <= rows.at(-1).sourceTimeMs) return false;
    rows.push({ ...tick });
    while (rows.length && (rows[0].sourceTimeMs < tick.sourceTimeMs - this.horizonMs || rows.length > this.maxTicks)) rows.shift();
    this.assets.set(tick.asset, rows);
    return true;
  }
  features(round, nowMs) {
    const rows = (this.assets.get(round.asset) ?? []).filter(t => t.sourceTimeMs <= nowMs && t.receivedTimeMs <= nowMs);
    if (!rows.length) return null;
    const latest = rows.at(-1);
    const price = units(latest.price);
    const target = units(round.targetPrice);
    if (target <= 0n) return null;
    const windows = {};
    for (const seconds of [3, 10, 30, 60]) {
      const sample = rows.filter(t => t.sourceTimeMs >= nowMs - seconds * 1000);
      windows[seconds] = {
        count: sample.length,
        coverageMs: sample.length ? latest.sourceTimeMs - sample[0].sourceTimeMs : 0,
        returnRatio: sample.length ? ratio(price - units(sample[0].price), units(sample[0].price)) : null,
      };
    }
    return { asset: round.asset, price: latest.price, targetPrice: round.targetPrice,
      leadRatio: ratio(price - target, target), remainingMs: round.endTimeMs - nowMs,
      sourceAgeMs: nowMs - latest.sourceTimeMs, windows };
  }
}

/** Both books must be normalized to the same round, outcome and tick size. */
export function validateBooks(a, b, { roundId, side, nowMs, maxAgeMs = 1000, tickSize = '0.01' }) {
  try {
    for (const book of [a, b]) {
      if (!book || book.roundId !== roundId || book.side !== side) return 'BOOK_IDENTITY_MISMATCH';
      if (!Number.isSafeInteger(book.observedAtMs) || book.observedAtMs > nowMs || nowMs - book.observedAtMs > maxAgeMs) return 'BOOK_STALE';
      if (!book.bids?.length || !book.asks?.length) return 'BOOK_EMPTY';
      for (const [levels, descending] of [[book.bids, true], [book.asks, false]]) {
        for (let i = 0; i < levels.length; i++) {
          const p = units(levels[i].price);
          if (p <= 0n || p >= units('1') || units(levels[i].shares) <= 0n) return 'BOOK_INVALID';
          if (i && (descending ? units(levels[i - 1].price) < p : units(levels[i - 1].price) > p)) return 'BOOK_UNSORTED';
        }
      }
      if (units(book.bids[0].price) >= units(book.asks[0].price)) return 'BOOK_CROSSED';
    }
    const abs = n => n < 0n ? -n : n;
    if (units(tickSize) <= 0n) return 'BOOK_INVALID';
    for (const key of ['bids', 'asks']) {
      if (abs(units(a[key][0].price) - units(b[key][0].price)) > units(tickSize)) return 'BOOK_DIVERGENCE';
    }
    return null;
  } catch { return 'BOOK_INVALID'; }
}
