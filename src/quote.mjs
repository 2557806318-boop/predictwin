import { units, SCALE, ceilDiv } from './money.mjs';

/** Total debit INCLUDES the explicit fee. Average price ALREADY includes impact.
 * A provider adapter must normalize native semantics to this contract.
 * Price impact is diagnostic: do not charge it twice.
 */
export function validateQuote(q, request, nowMs) {
  try {
    if (!q || typeof q.id !== 'string' || !q.id || q.roundId !== request.roundId || q.side !== request.side) return { ok: false, reason: 'QUOTE_IDENTITY' };
    if (!Number.isSafeInteger(q.expireAtMs) || q.expireAtMs <= nowMs) return { ok: false, reason: 'QUOTE_EXPIRED' };
    const debit = units(q.totalDebitWei);
    const fee = units(q.feeWei);
    const shares = units(q.sharesWei);
    const average = units(q.averagePrice);
    const probability = units(request.probabilityLower);
    const minEdge = units(request.minEdge);
    if (debit !== request.budgetWei) return { ok: false, reason: 'QUOTE_AMOUNT_MISMATCH' };
    if (debit <= 0n || fee < 0n || fee >= debit || shares <= 0n || average <= 0n || average >= SCALE || probability <= 0n || probability > SCALE || minEdge < 0n) return { ok: false, reason: 'QUOTE_INVALID' };
    // Allow one wei of rounding in provider average-price normalization.
    const calculated = ceilDiv(average * shares, SCALE);
    const diff = calculated - (debit - fee);
    if (diff > 1n || diff < -1n) return { ok: false, reason: 'QUOTE_COST_INCONSISTENT' };
    const cost = ceilDiv(debit * SCALE, shares);
    if (cost >= SCALE || probability - cost < minEdge) return { ok: false, reason: 'NO_NET_EDGE' };
    return { ok: true, effectiveCost: cost, edge: probability - cost };
  } catch { return { ok: false, reason: 'QUOTE_INVALID' }; }
}
