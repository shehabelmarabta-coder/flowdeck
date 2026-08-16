'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoBotEngine } = require('../src/bot-engine');
const { normalizeConfig } = require('../src/default-config');
const { PaperExecutionAdapter } = require('../src/execution-adapters');
const { TrajectoryIndex } = require('../src/trajectory');

const WALLET = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';
const MINTS = [
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

class MemoryAudit {
  constructor() { this.events = []; this.trades = []; }
  writeEvent(row) { this.events.push(structuredClone(row)); return { written: true }; }
  writeTrade(row) { this.trades.push(structuredClone(row)); return { written: true }; }
  status() { return { enabled: true, eventsWritten: this.events.length, tradesWritten: this.trades.length }; }
}

function fixture() {
  let now = 1_000_000;
  const audit = new MemoryAudit();
  const config = normalizeConfig({
    wallets: [{ address: WALLET, enabled: true, weight: 1 }],
    paper: { latencyMs: 0, detectionToDecisionMs: 0, maxPriceAgeMs: 60_000 },
    priceFallback: { enabled: false }, gmgn: { discoveryEnabled: false }
  });
  const engine = new AutoBotEngine({ config, store: null, clock: () => now, trajectoryIndex: new TrajectoryIndex(), auditWriter: audit, sessionId: 'paper-test-session' });
  engine.setExecutionAdapters({ BOT_PAPER: new PaperExecutionAdapter({ engine, config, waitImpl: async () => {} }) });
  return { engine, audit, setNow: (value) => { now = value; }, advance: (value) => { now += value; }, now: () => now };
}

test('per-mint candidates survive concurrent signals, wait for price, fill when price arrives, and expire at 20 seconds', async () => {
  const { engine, advance } = fixture();
  engine.setAutoRun(true);
  let result = await engine.handleWalletSignal({ mint: MINTS[0], wallet: WALLET, side: 'buy', signature: 'wait-a' });
  assert.equal(result.status, 'awaiting-price');
  result = await engine.handleWalletSignal({ mint: MINTS[1], wallet: WALLET, side: 'buy', signature: 'wait-b' });
  assert.equal(result.status, 'awaiting-price');
  assert.equal(Object.keys(engine.state.bot.candidates).length, 2);
  assert.equal(engine.state.bot.candidates[MINTS[0]].state, 'WAITING_PRICE');
  assert.equal(engine.state.bot.candidates[MINTS[1]].state, 'WAITING_PRICE');

  engine.setMarket({ mint: MINTS[0], priceUsd: 0.001, source: 'gmgn-network' });
  await flush(); await flush();
  assert.equal(engine.state.bot.candidates[MINTS[0]].state, 'BOUGHT');
  assert.equal(engine.snapshot().botPositions[0].initialAmountSol, 0.01);
  assert.ok(engine.snapshot().botPositions[0].entryAt - engine.state.bot.candidates[MINTS[0]].firstSignalAt < 1000);

  advance(20_001);
  await engine.auditTick();
  assert.equal(engine.state.bot.candidates[MINTS[1]].state, 'EXPIRED');
});

test('market-cap-only entry is PROXY_ONLY, samples at 5 seconds, uses normal exits, and stays out of realistic PnL', async () => {
  const { engine, audit, advance } = fixture();
  engine.setMarket({ mint: MINTS[0], symbol: 'PROXY', marketCapUsd: 100_000, source: 'gmgn-trenches' });
  engine.setAutoRun(true);
  const result = await engine.handleWalletSignal({ mint: MINTS[0], wallet: WALLET, side: 'buy', signature: 'proxy-buy', lifecycleStage: 'NEAR_COMPLETION' });
  assert.equal(result.status, 'filled');
  const position = engine.snapshot().botPosition;
  assert.equal(position.fillQuality, 'PROXY_ONLY');
  assert.equal(position.pricingUnit, 'MARKET_CAP_RATIO');
  assert.equal(position.entryPriceUsd, null);
  assert.equal(audit.events.filter((row) => row.event_type === 'POSITION_SAMPLE').length, 0);
  advance(4_999); await engine.auditTick();
  assert.equal(audit.events.filter((row) => row.event_type === 'POSITION_SAMPLE').length, 0);
  advance(1); await engine.auditTick(); await engine.auditTick();
  assert.equal(audit.events.filter((row) => row.event_type === 'POSITION_SAMPLE').length, 1);

  engine.setMarket({ mint: MINTS[0], marketCapUsd: position.entryIndex * 1.16, source: 'gmgn-trenches' });
  await flush();
  assert.equal(engine.snapshot().botPosition.stage, 'AFTER_TP1');
  engine.setMarket({ mint: MINTS[0], marketCapUsd: position.entryIndex * 1.51, source: 'gmgn-trenches' });
  await flush();
  assert.equal(engine.snapshot().botPositions.length, 0);
  assert.equal(audit.trades.length, 1);
  assert.ok(audit.trades[0].tp1_timestamp_utc);
  assert.ok(audit.trades[0].final_exit_timestamp_utc);
  assert.equal(audit.trades[0].used_proxy_index, true);
  assert.equal(engine.snapshot().sessionStatistics.proxy.completedTrades, 1);
  assert.equal(engine.snapshot().sessionStatistics.executable.completedTrades, 0);
  assert.equal(engine.snapshot().sessionStatistics.realisticNetPnlSol, 0);

  const beforePostExit = audit.events.filter((row) => row.notes === 'POST_EXIT_60M').length;
  advance(29_999); await engine.auditTick();
  assert.equal(audit.events.filter((row) => row.notes === 'POST_EXIT_60M').length, beforePostExit);
  advance(1); await engine.auditTick();
  assert.equal(audit.events.filter((row) => row.notes === 'POST_EXIT_60M').length, beforePostExit + 1);

  engine.setMarket({ mint: MINTS[1], symbol: 'ABS', priceUsd: 2, source: 'gmgn-network' });
  assert.equal((await engine.handleWalletSignal({ mint: MINTS[1], wallet: WALLET, side: 'buy', signature: 'absolute-buy', lifecycleStage: 'MIGRATED' })).status, 'filled');
  const absolute = engine.snapshot(MINTS[1]).botPosition;
  assert.equal(absolute.fillQuality, 'EXECUTABLE_PRICE');
  engine.setMarket({ mint: MINTS[1], priceUsd: absolute.entryIndex * 1.16, source: 'gmgn-network' }); await flush();
  engine.setMarket({ mint: MINTS[1], priceUsd: absolute.entryIndex * 1.51, source: 'gmgn-network' }); await flush();
  const separated = engine.snapshot().sessionStatistics;
  assert.equal(separated.all.completedTrades, 2);
  assert.equal(separated.executable.completedTrades, 1);
  assert.equal(separated.proxy.completedTrades, 1);
  assert.equal(separated.realisticNetPnlSol, separated.executable.realizedNetPnlSol);
});

test('new, near-completion, and migrated trenches lifecycle stages are recorded', () => {
  const { engine, audit } = fixture();
  engine.observeDiscovery({ mint: MINTS[0], symbol: 'NEW', status: 'NEW' });
  engine.observeDiscovery({ mint: MINTS[1], symbol: 'NEAR', status: 'PRE-ARMED' });
  engine.observeDiscovery({ mint: MINTS[2], symbol: 'MIG', status: 'MIGRATED' });
  assert.deepEqual(MINTS.map((mint) => engine.state.bot.candidates[mint].lifecycleStage), ['NEW_CREATION', 'NEAR_COMPLETION', 'MIGRATED']);
  assert.deepEqual(audit.events.filter((row) => row.event_type === 'CANDIDATE_CREATED').map((row) => row.lifecycle_stage), ['NEW_CREATION', 'NEAR_COMPLETION', 'MIGRATED']);
});

test('paper hard blockers cover pause, duplicate tuple, capacity, and insufficient balance', async () => {
  const { engine } = fixture();
  let result = await engine.handleWalletSignal({ mint: MINTS[0], wallet: WALLET, side: 'buy', signature: 'paused' });
  assert.equal(result.reason, 'auto-paused');
  result = await engine.handleWalletSignal({ mint: MINTS[0], wallet: WALLET, side: 'buy', signature: 'paused' });
  assert.equal(result.status, 'duplicate');

  engine.setAutoRun(true);
  for (let index = 0; index < 20; index += 1) engine.state.bot.positions[`fake-${index}`] = { mode: 'BOT_PAPER' };
  result = await engine.handleWalletSignal({ mint: MINTS[1], wallet: WALLET, side: 'buy', signature: 'capacity' });
  assert.match(result.reason, /maximum open paper positions/);
  engine.state.bot.positions = {};
  engine.state.balanceSol = 0;
  result = await engine.handleWalletSignal({ mint: MINTS[2], wallet: WALLET, side: 'buy', signature: 'balance' });
  assert.match(result.reason, /insufficient paper balance/);
});
