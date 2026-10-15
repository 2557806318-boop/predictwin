import { units, SCALE, decimal } from './money.mjs';

/** Deliberately no SDK, keys, wallet, transfer or live-order implementation. */
export class ProviderAdapter {
  async books(_request) { throw new Error('PROVIDER_NOT_IMPLEMENTED'); }
  async quote(_request) { throw new Error('PROVIDER_NOT_IMPLEMENTED'); }
}

/** Fabricated data for reproducible tests, NEVER a venue fill prediction. */
export class SyntheticProvider extends ProviderAdapter {
  async books({ roundId, side, nowMs }) {
    const book = { roundId, side, observedAtMs: nowMs,
      bids: [{ price: '0.49', shares: '1000' }], asks: [{ price: '0.50', shares: '1000' }] };
    return [structuredClone(book), structuredClone(book)];
  }
  async quote({ roundId, side, budgetWei, nowMs }) {
    const feeWei = budgetWei / 100n;
    const sharesWei = (budgetWei - feeWei) * 2n;
    return { id: `synthetic-${roundId}-${side}`, roundId, side, totalDebitWei: budgetWei,
      sharesWei, feeWei, averagePrice: decimal((budgetWei - feeWei) * SCALE / sharesWei),
      expireAtMs: nowMs + 5000, synthetic: true };
  }
}

/** Optional PUBLIC spot feed; not prediction settlement truth. No private API. */
export async function connectPublicSpot({ symbols, onTick, signal }) {
  if (!symbols.length || symbols.some(s => !/^[a-z0-9]+$/.test(s))) throw new Error('Invalid symbols');
  const streams = symbols.map(s => `${s}@trade`).join('/');
  const socket = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  socket.addEventListener('message', event => {
    try {
      const { data } = JSON.parse(event.data);
      if (!data || typeof data.s !== 'string' || units(data.p) <= 0n) return;
      onTick({ asset: data.s, price: data.p, sourceTimeMs: data.T, receivedTimeMs: Date.now() });
    } catch { /* Do not print raw messages or URLs containing credentials. */ }
  });
  const close = () => socket.close();
  if (signal?.aborted) close(); else signal?.addEventListener('abort', close, { once: true });
  socket.addEventListener('close', () => signal?.removeEventListener('abort', close));
  return socket;
}
