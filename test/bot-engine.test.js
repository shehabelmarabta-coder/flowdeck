'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoBotEngine } = require('../src/bot-engine');
const { normalizeConfig } = require('../src/default-config');
const { PaperExecutionAdapter } = require('../src/execution-adapters');
const { TrajectoryIndex } = require('../src/trajectory');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLETS = [
  '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b', '2PLWjaYV7KiKMmUXkC2d4qxqTXjSDMm4EDXqCXw7MRr1',
  '9PWZLzVSLNxCoYCKLKqpprusX5ygMVqo6a6L5Ro6JQYL', 'ETvjY89JCc7b1n3vBawD3aFZ9sue4nfSVbxaZX7k46LM',
  '5pebPyBJofjzdGQbeNAC728xxBUgnnLcHRfdqkGLKTUX', 'bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa'
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let now = 1_000_000;
  const config = normalizeConfig({
    wallets: WALLETS.map((address) => ({ address, enabled: true, weight: 1 })),
    paper: { latencyMs: 0, detectionToDecisionMs: 0, maxPriceAgeMs: 10_000 },
    bot: { orderSol: 0.02, normal: { walletCount: 4, weightedConsensusPct: 10, windowSeconds: 60 }, strong: { walletCount: 6, weightedConsensusPct: 15, windowSeconds: 45 } },
    priceFallback: { enabled: false }, gmgn: { discoveryEnabled: false }
  });
  const engine = new AutoBotEngine({ config, store: null, clock: () => now, trajectoryIndex: new TrajectoryIndex() });
  const paper = new PaperExecutionAdapter({ engine, config, waitImpl: async () => {} });
  engine.setExecutionAdapters({ BOT_PAPER: paper });
  return { engine, setNow: (value) => { now = value; }, getNow: () => now };
}

test('one enabled wallet BUY immediately opens a 0.01 SOL aggressive paper position', async () => {
  const { engine } = fixture();
  engine.setMarket({ mint: MINT, priceUsd: 1, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  engine.setAutoRun(true);
  const result = await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[0], side: 'buy', signature: 'single-paper-buy' });
  assert.equal(result.status, 'filled');
  assert.equal(engine.snapshot().botPositions.length, 1);
  assert.equal(engine.snapshot().botPosition.initialAmountSol, 0.01);
  assert.equal(engine.snapshot().candidate.state, 'BOUGHT');
});

test('BOT_LIVE keeps the existing consensus and unavailable-history gates', async () => {
  const { engine } = fixture();
  const adapter = engine.executionAdapters.BOT_PAPER;
  engine.setExecutionAdapters({ BOT_PAPER: adapter, BOT_LIVE: adapter });
  assert.equal(engine.setMode('BOT_LIVE', { confirmation: 'LIVE', readiness: { ready: true } }).status, 'ok');
  engine.setMarket({ mint: MINT, priceUsd: 1, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  engine.setAutoRun(true);
  for (let index = 0; index < 4; index += 1) await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[index], side: 'buy', signature: `live-normal-${index}` });
  assert.equal(engine.snapshot().botPositions.length, 0);
  assert.match(engine.snapshot().candidate.reason, /strong wallet consensus required/);
  for (let index = 4; index < 6; index += 1) await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[index], side: 'buy', signature: `live-strong-${index}` });
  assert.equal(engine.snapshot().botPositions.length, 1);
});

test('TP1 sells exactly 50% and the remainder follows the final exit state', async () => {
  const { engine } = fixture();
  engine.setMarket({ mint: MINT, priceUsd: 1, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  engine.setAutoRun(true);
  for (let index = 0; index < 6; index += 1) await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[index], side: 'buy', signature: `e-${index}` });
  const entry = engine.snapshot().botPosition.entryPriceUsd;
  engine.setMarket({ mint: MINT, priceUsd: entry * 1.16, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  await flush();
  assert.equal(engine.snapshot().botPosition.stage, 'AFTER_TP1');
  assert.equal(engine.snapshot().botPosition.remainingPct, 50);
  assert.equal(engine.state.lots[0].remainingQuantityIndex / engine.state.lots[0].initialQuantityIndex, 0.5);
  engine.setMarket({ mint: MINT, priceUsd: entry * 1.51, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  await flush();
  assert.equal(engine.snapshot().botPositions.length, 0);
  assert.equal(engine.state.closedTrades.length, 2);
  assert.deepEqual(engine.state.closedTrades.map((trade) => trade.reason), ['tp1', 'final-take-profit']);
});

test('a deterministic missing paper exit route does not require reconciliation', async () => {
  const { engine } = fixture();
  engine.setMarket({ mint: MINT, priceUsd: 1, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'fixture' });
  engine.setAutoRun(true);
  await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[0], side: 'buy', signature: 'paper-no-route-entry' });
  const entry = engine.snapshot().botPosition.entryPriceUsd;
  engine.setExecutionAdapters({
    BOT_PAPER: {
      client: {},
      quote: async () => ({ ok: false, routeable: false, reason: 'no-fresh-reverse-route' }),
      sellPercent: async () => { throw new Error('sell must not be attempted without a route'); }
    }
  });

  engine.setMarket({ mint: MINT, priceUsd: entry * 0.5, liquidityUsd: 30_000, migrated: true, routeable: false, source: 'fixture' });
  await flush();

  assert.equal(engine.state.bot.autoRun, true);
  assert.equal(engine.state.bot.needsReconciliation, false);
  assert.equal(engine.state.bot.pendingDecision, null);
  assert.equal(engine.state.bot.positions[MINT].routeStatus, 'UNSELLABLE/NO_ROUTE');
});

test('a persisted failed paper decision is cleared during hydration', () => {
  const { engine: original } = fixture();
  const saved = structuredClone(original.state);
  const failed = { id: 'decision-failed', action: 'sell', mint: MINT, status: 'failed' };
  saved.bot.pendingDecision = failed;
  saved.bot.positions[MINT] = { mint: MINT, mode: 'BOT_PAPER', pendingAction: failed };
  const store = { loadState: () => saved, saveState() {}, appendEvent() {} };
  const reloaded = new AutoBotEngine({ config: original.config, store, trajectoryIndex: new TrajectoryIndex() });

  assert.equal(reloaded.state.bot.needsReconciliation, false);
  assert.equal(reloaded.state.bot.pendingDecision, null);
  assert.equal(reloaded.state.bot.positions[MINT].pendingAction, null);
});
