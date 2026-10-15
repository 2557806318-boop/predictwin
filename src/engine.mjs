import { performance } from 'node:perf_hooks';
import { validateBooks } from './market-data.mjs';
import { validateQuote } from './quote.mjs';
import { units } from './money.mjs';

/** Paper pipeline only. Does NOT submit exchange orders or promise FOK fills. */
export class PaperEngine {
  constructor({ store, provider, strategy, now = Date.now, maxAllocationBps = 1000, maxSourceAgeMs = 1000, timeoutMs = 2000 }) {
    if (!Number.isInteger(maxAllocationBps) || maxAllocationBps < 1 || maxAllocationBps > 10000) throw new RangeError('Invalid paper cap');
    Object.assign(this, { store, provider, strategy, now, maxAllocationBps, maxSourceAgeMs, timeoutMs });
    this.inFlight = false;
  }
  async timed(segment, fn) {
    const start = performance.now();
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([fn(controller.signal), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('PROVIDER_TIMEOUT')); }, this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); this.store.recordLatency(segment, performance.now() - start); }
  }
  async evaluate(round, features) {
    if (this.inFlight) return { state: 'SKIPPED', reason: 'PIPELINE_BUSY' };
    this.inFlight = true;
    const start = performance.now();
    const reject = reason => { const result = { state: 'SKIPPED', reason, roundId: round.roundId }; this.store.audit('decision', result); return result; };
    try {
      if (!features || !Number.isFinite(features.sourceAgeMs) || features.sourceAgeMs < 0 || features.sourceAgeMs > this.maxSourceAgeMs) return reject('SOURCE_STALE');
      if (units(round.targetPrice) <= 0n || !Number.isSafeInteger(round.endTimeMs) || this.now() >= round.endTimeMs) return reject('ROUND_INVALID');
      if (this.store.hasRound(round.roundId)) return reject('ROUND_ALREADY_FILLED');
      const inferenceStart = performance.now();
      const decision = await this.strategy({ round: structuredClone(round), features: structuredClone(features), nowMs: this.now() });
      this.store.recordLatency('inference', performance.now() - inferenceStart);
      if (decision.action !== 'CANDIDATE') return reject('STRATEGY_NOT_IMPLEMENTED_OR_SKIPPED');
      if (!['UP', 'DOWN'].includes(decision.side) || typeof decision.budgetWei !== 'bigint' || decision.budgetWei <= 0n) return reject('INVALID_CANDIDATE');
      const maxBudget = this.store.available() * BigInt(this.maxAllocationBps) / 10000n;
      if (decision.budgetWei > maxBudget) return reject('PAPER_ALLOCATION_LIMIT');
      const request = { ...decision, roundId: round.roundId, nowMs: this.now() };
      const books = await this.timed('officialBookRtt', signal => this.provider.books({ ...request, signal }));
      const bookError = validateBooks(books[0], books[1], { ...request, nowMs: this.now() });
      if (bookError) return reject(bookError);
      this.store.recordLatency('decisionToQuoteDispatch', performance.now() - start);
      // Exactly one quote for the actual intended debit; never resize/retry here.
      const quote = await this.timed('quoteRtt', signal => this.provider.quote({ ...request, nowMs: this.now(), signal }));
      const checked = validateQuote(quote, request, this.now());
      if (!checked.ok) return reject(checked.reason);
      const finalBookError = validateBooks(books[0], books[1], { ...request, nowMs: this.now() });
      if (finalBookError) return reject(finalBookError);
      if (this.now() >= round.endTimeMs) return reject('ROUND_ENDED_DURING_QUOTE');
      if (features.sourceAgeMs + performance.now() - start > this.maxSourceAgeMs) return reject('SOURCE_AGED_DURING_QUOTE');
      // Audit only the normalized fields, not provider payloads/headers/signatures.
      this.store.audit('quote', { roundId: round.roundId, side: request.side, budgetWei: request.budgetWei,
        sharesWei: quote.sharesWei, feeWei: quote.feeWei, effectiveCost: checked.effectiveCost, synthetic: quote.synthetic === true });
      const result = this.store.fill(round, request, quote, this.now());
      this.store.audit('paperFill', result);
      return result;
    } catch {
      // Never persist raw SDK errors: they may include signed URLs or credentials.
      return reject('PIPELINE_ERROR_OR_TIMEOUT');
    } finally {
      this.store.recordLatency('pipelineTotal', performance.now() - start);
      this.inFlight = false;
    }
  }
}
