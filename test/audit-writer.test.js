'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CsvAuditWriter, EVENT_HEADERS, TRADE_HEADERS } = require('../src/audit-writer');

test('daily audit CSV keeps one stable header, escapes fields, redacts secrets, and dedupes after restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-08-14T12:00:00.000Z');
  const secret = 'gmgn-super-secret';
  const create = () => new CsvAuditWriter({ directory, clock: () => now, secrets: () => [secret] });
  const row = {
    strategy_version: 'paper-aggressive-v1', session_id: 'session-1', event_id: 'event-1',
    timestamp_utc: new Date(now).toISOString(), event_type: 'POSITION_SAMPLE',
    notes: `comma, quote " and newline\n${secret}`
  };
  assert.equal(create().writeEvent(row).written, true);
  assert.equal(create().writeEvent(row).duplicate, true);
  const events = create().read('events', '2026-08-14');
  assert.equal(events.split(/\r?\n/)[0], EVENT_HEADERS.join(','));
  assert.equal(events.match(new RegExp(EVENT_HEADERS.join(',').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1);
  assert.equal((events.match(/event-1/g) || []).length, 1);
  assert.match(events, /"comma, quote "" and newline/);
  assert.doesNotMatch(events, new RegExp(secret));
  assert.match(events, /\[REDACTED\]/);

  const trade = {
    strategy_version: 'paper-aggressive-v1', session_id: 'session-1', trade_id: 'trade-1',
    final_exit_timestamp_utc: new Date(now).toISOString(), mint: 'So11111111111111111111111111111111111111112'
  };
  const writer = create();
  assert.equal(writer.writeTrade(trade).written, true);
  assert.equal(writer.writeTrade(trade).duplicate, true);
  assert.equal(writer.read('trades', '2026-08-14').split(/\r?\n/)[0], TRADE_HEADERS.join(','));

  now = Date.parse('2026-08-15T00:00:01.000Z');
  assert.equal(create().writeEvent({ ...row, event_id: 'event-2', timestamp_utc: new Date(now).toISOString() }).written, true);
  assert.ok(fs.existsSync(path.join(directory, 'flowdeck-paper-events-2026-08-15.csv')));
});

test('queued evidence is flushed before export and remains deduped after restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-audit-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timestamp = '2026-08-14T12:00:00.000Z';
  const row = { session_id: 'session-queue', event_id: 'rpc:notification:one', timestamp_utc: timestamp, event_type: 'RPC_NOTIFICATION' };
  const create = () => new CsvAuditWriter({ directory, clock: () => Date.parse(timestamp) });

  const writer = create();
  assert.equal(writer.queueEvent(row).queued, true);
  assert.match(writer.read('events', '2026-08-14'), /rpc:notification:one/);
  assert.equal(create().writeEvent(row).duplicate, true);
  assert.ok(fs.existsSync(path.join(directory, '.dedupe', 'flowdeck-paper-events-2026-08-14.csv.event_id.jsonl')));
});
