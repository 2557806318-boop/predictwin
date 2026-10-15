import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { json, units, decimal } from './money.mjs';
import { quantile } from './utils.mjs';

/** One writer; bounded queries. All monetary columns contain decimal bigint TEXT. */
export class Store {
  constructor(path = ':memory:', initialCash = '100') {
    const cash = units(initialCash);
    if (cash <= 0n) throw new RangeError('Positive paper capital required');
    this.db = new DatabaseSync(path);
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length && !tables.some(t => t.name === 'framework_identity')) {
      this.db.close(); throw new Error('REFUSE_EXISTING_NON_FRAMEWORK_DATABASE');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS framework_identity (version INTEGER PRIMARY KEY CHECK(version=1));
      INSERT OR IGNORE INTO framework_identity VALUES (1);
      CREATE TABLE IF NOT EXISTS cash (id INTEGER PRIMARY KEY CHECK(id=1), amount TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS latency (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, segment TEXT NOT NULL, ms REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS latency_segment_time ON latency(segment,at_ms);
      CREATE TABLE IF NOT EXISTS fills (round_id TEXT PRIMARY KEY, asset TEXT NOT NULL, side TEXT NOT NULL,
        debit TEXT NOT NULL, shares TEXT NOT NULL, opened_ms INTEGER NOT NULL, state TEXT NOT NULL,
        settled_ms INTEGER, label TEXT, payout TEXT, pnl TEXT, quote_id TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO cash VALUES(1,?)').run(cash.toString());
  }
  measure(segment, fn) {
    const start = performance.now();
    try { return fn(); }
    finally { this.recordLatency(segment, performance.now() - start); }
  }
  recordLatency(segment, ms, atMs = Date.now()) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.db.prepare('INSERT INTO latency(at_ms,segment,ms) VALUES(?,?,?)').run(atMs, segment, ms);
  }
  audit(kind, payload, atMs = Date.now()) {
    this.measure('database.auditWrite', () => this.db.prepare('INSERT INTO events(at_ms,kind,payload) VALUES(?,?,?)').run(atMs, kind, json(payload)));
  }
  available() { return BigInt(this.db.prepare('SELECT amount FROM cash WHERE id=1').get().amount); }
  hasRound(id) { return Boolean(this.db.prepare('SELECT 1 FROM fills WHERE round_id=?').get(id)); }
  /** Synchronous transaction makes cash debit + fill atomic across assets. */
  fill(round, request, quote, nowMs) {
    return this.measure('database.fillWrite', () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.hasRound(round.roundId)) throw new Error('ROUND_ALREADY_FILLED');
        const cash = this.available();
        if (request.budgetWei <= 0n || request.budgetWei > cash) throw new Error('INSUFFICIENT_PAPER_CASH');
        if (quote.totalDebitWei !== request.budgetWei || quote.sharesWei <= 0n) throw new Error('INVALID_FILL');
        this.db.prepare('UPDATE cash SET amount=? WHERE id=1').run((cash - request.budgetWei).toString());
        this.db.prepare(`INSERT INTO fills(round_id,asset,side,debit,shares,opened_ms,state,quote_id)
          VALUES(?,?,?,?,?,?,'OPEN',?)`).run(round.roundId, round.asset, request.side,
          request.budgetWei.toString(), quote.sharesWei.toString(), nowMs, quote.id);
        this.db.exec('COMMIT');
        return { state: 'PAPER_FILLED', roundId: round.roundId };
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  /** Flat outcomes require an explicit provider-specific rule; no assumed refund. */
  settle(roundId, label, flatRule, nowMs = Date.now()) {
    if (!['UP', 'DOWN', 'FLAT'].includes(label)) throw new Error('INVALID_SETTLEMENT');
    if (label === 'FLAT' && !['UP', 'DOWN', 'REFUND'].includes(flatRule)) throw new Error('FLAT_RULE_REQUIRED');
    return this.measure('database.settlementWrite', () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.db.prepare('SELECT * FROM fills WHERE round_id=?').get(roundId);
        if (!row || row.state === 'SETTLED') { this.db.exec('COMMIT'); return false; }
        const outcome = label === 'FLAT' ? flatRule : label;
        const payout = outcome === 'REFUND' ? BigInt(row.debit) : outcome === row.side ? BigInt(row.shares) : 0n;
        this.db.prepare('UPDATE cash SET amount=? WHERE id=1').run((this.available() + payout).toString());
        this.db.prepare("UPDATE fills SET state='SETTLED',settled_ms=?,label=?,payout=?,pnl=? WHERE round_id=?")
          .run(nowMs, label, payout.toString(), (payout - BigInt(row.debit)).toString(), roundId);
        this.db.exec('COMMIT'); return true;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  trades() { return this.db.prepare('SELECT * FROM fills ORDER BY opened_ms DESC LIMIT 100').all(); }
  status() {
    return this.measure('database.statusQuery', () => ({ mode: 'PAPER_ONLY', synthetic: true,
      availableCash: decimal(this.available()), openPositions: this.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE state='OPEN'").get().n,
      trades: this.db.prepare('SELECT COUNT(*) AS n FROM fills').get().n }));
  }
  events() { return this.db.prepare('SELECT at_ms,kind,payload FROM events ORDER BY id DESC LIMIT 30').all().map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  latencySummary() {
    // Persistent, explicitly bounded window; does not become zero after restart.
    const rows = this.db.prepare('SELECT * FROM latency ORDER BY id DESC LIMIT 10000').all();
    const groups = Map.groupBy(rows, r => r.segment);
    return { scope: 'LAST_10000_PERSISTED_SAMPLES', metrics: Object.fromEntries([...groups].map(([segment, samples]) => {
      const values = samples.map(r => r.ms);
      return [segment, { count: samples.length, fromMs: Math.min(...samples.map(r => r.at_ms)), toMs: Math.max(...samples.map(r => r.at_ms)),
        p50: quantile(values, .5), p95: quantile(values, .95), p99: quantile(values, .99) }];
    })) };
  }
  prune(beforeMs) {
    // Only diagnostic events/latency. Never delete accounting records here.
    this.db.prepare('DELETE FROM events WHERE at_ms<?').run(beforeMs);
    this.db.prepare('DELETE FROM latency WHERE at_ms<?').run(beforeMs);
  }
  close() { this.db.close(); }
}
