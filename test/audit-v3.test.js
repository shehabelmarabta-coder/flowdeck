'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CsvAuditWriter, V3_SCHEMA_VERSION } = require('../src/audit-writer');
const { HEADERS, RefinedAuditWriter, SCHEMA_VERSION } = require('../src/refined-audit');

test('v3 ledgers dedupe IDs and reconcile exact trade arithmetic', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-v3-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  const writer = new CsvAuditWriter({ directory, clock: () => now });
  const timestamp_utc = new Date(now).toISOString();
  const fillBase = { strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', session_id: 's', position_id: 'p', decision_id: 'd', snapshot_id: 'snap', timestamp_utc };
  writer.writeFill({ ...fillBase, fill_id: 'entry', side: 'buy', exit_stage: 'ENTRY', input_amount_atomic: '10000000', output_amount_atomic: '1000', realized_pnl_lamports: '0' });
  writer.writeFill({ ...fillBase, fill_id: 'exit', side: 'sell', exit_stage: 'FINAL', input_amount_atomic: '1000', output_amount_atomic: '12000000', realized_pnl_lamports: '1790000' });
  assert.equal(writer.writeFill({ ...fillBase, fill_id: 'exit', side: 'sell', exit_stage: 'FINAL' }).duplicate, true);
  writer.writeV3Trade({
    strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', session_id: 's', trade_id: 't', position_id: 'p', decision_id: 'd', snapshot_id: 'snap',
    final_exit_timestamp_utc: timestamp_utc, entry_spend_lamports: '10000000', explicit_modelled_costs_lamports: '210000',
    total_exit_proceeds_lamports: '12000000', net_pnl_lamports: '1790000'
  });
  const result = writer.reconcileV3('2026-08-14', 's');
  assert.equal(result.reconciled, true);
  assert.equal(result.fills, 2);
  assert.equal(result.trades, 1);
  assert.equal(result.netPnlLamports, '1790000');
  assert.equal(result.fillRealizedPnlLamports, '1790000');
  assert.match(writer.read('fills', '2026-08-14'), new RegExp(`^${V3_SCHEMA_VERSION}`, 'm'));
});

test('final audit creates only compact append-only event, trade and wallet-stat CSV families', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-final-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  const writer = new RefinedAuditWriter({ directory, clock: () => now });
  const timestamp = new Date(now).toISOString();
  writer.writeEvent({ session_id: 's', event_id: 'e', timestamp_utc: timestamp, event_type: 'CANDIDATE_OBSERVED' });
  writer.writeTrade({ session_id: 's', trade_id: 't', exit_timestamp_utc: timestamp, mint: 'm', record_json: { exact: true } });
  writer.writeWalletStats({ session_id: 's', stats_id: 'w', timestamp_utc: timestamp, wallet: 'wallet' });
  assert.deepEqual(fs.readdirSync(directory).sort(), ['events-2026-08-14.csv', 'trades-2026-08-14.csv', 'wallet-stats-2026-08-14.csv']);
  assert.equal(writer.status().schemaVersion, SCHEMA_VERSION);
  for (const kind of ['events', 'trades', 'wallet-stats']) assert.equal(writer.read(kind).split(/\r?\n/, 1)[0], HEADERS[kind].join(','));
});

test('a stale on-disk header from an older schema never receives current-schema rows misaligned underneath it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-drift-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const timestamp = new Date(now).toISOString();
  // Simulate a file already on disk from an older code version with fewer trade columns.
  const stalePath = path.join(directory, 'trades-2026-08-15.csv');
  const staleHeaders = HEADERS.trades.slice(0, HEADERS.trades.length - 6);
  fs.writeFileSync(stalePath, `${staleHeaders.join(',')}\r\ns,old-trade,${timestamp},m,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,\r\n`);
  const writer = new RefinedAuditWriter({ directory, clock: () => now });
  const result = writer.writeTrade({ session_id: 's', trade_id: 'current-trade', exit_timestamp_utc: timestamp, mint: 'm', record_json: { exact: true } });
  assert.equal(result.written, true);
  assert.notEqual(result.filePath, stalePath);
  assert.match(result.filePath, /trades-2026-08-15\.v2\.csv$/);
  const stale = fs.readFileSync(stalePath, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(stale[0], staleHeaders.join(','), 'the old file is left exactly as it was, not rewritten');
  assert.equal(stale.length, 2, 'the old file still only has its original one data row');
  const current = writer.read('trades', '2026-08-15').split(/\r?\n/).filter(Boolean);
  assert.equal(current[0], HEADERS.trades.join(','));
  assert.equal(current.length, 2);
  assert.equal(current[0].split(',').length, current[1].split(',').length, 'header and row column counts match in the fresh, correctly-scoped file');
});
