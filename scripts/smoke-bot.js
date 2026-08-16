'use strict';

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

class MemoryStore {
  constructor() { this.persisted = null; this.events = []; }
  loadState() { return this.persisted ? structuredClone(this.persisted) : null; }
  saveState(state) { this.persisted = structuredClone(state); }
  appendEvent(event) { this.events.push(structuredClone(event)); }
}

async function runSmoke() {
  let now = 1_000_000;
  const config = normalizeConfig({
    wallets: WALLETS.map((address) => ({ address, enabled: true, weight: 1 })),
    paper: { latencyMs: 0, detectionToDecisionMs: 0, maxPriceAgeMs: 10_000 },
    bot: { orderSol: 0.02 },
    priceFallback: { enabled: false }, gmgn: { discoveryEnabled: false }
  });
  const store = new MemoryStore();
  const engine = new AutoBotEngine({ config, store, clock: () => now, trajectoryIndex: new TrajectoryIndex() });
  engine.setExecutionAdapters({ BOT_PAPER: new PaperExecutionAdapter({ engine, config, waitImpl: async () => {} }) });
  engine.setMarket({ mint: MINT, symbol: 'SMOKE', priceUsd: 1, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'smoke-fixture' });
  engine.setAutoRun(true);
  for (let index = 0; index < WALLETS.length; index += 1) await engine.handleWalletSignal({ mint: MINT, wallet: WALLETS[index], side: 'buy', signature: `smoke-${index}`, observedAt: now });
  const entry = engine.snapshot(MINT).botPosition.entryPriceUsd;
  now += 60_000;
  engine.setMarket({ mint: MINT, symbol: 'SMOKE', priceUsd: entry * 1.16, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'smoke-fixture' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.snapshot(MINT).botPosition.stage, 'AFTER_TP1');
  now += 60_000;
  engine.setMarket({ mint: MINT, symbol: 'SMOKE', priceUsd: entry * 1.51, liquidityUsd: 30_000, migrated: true, routeable: true, source: 'smoke-fixture' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.state.closedTrades.length, 2);
  const restarted = new AutoBotEngine({ config, store, clock: () => now, trajectoryIndex: new TrajectoryIndex() });
  const uiSnapshot = restarted.snapshot(MINT);
  assert.equal(uiSnapshot.mode, 'BOT_PAPER');
  assert.equal(uiSnapshot.autoRun, false);
  assert.equal(uiSnapshot.recentClosedTrades.length, 2);
  assert.equal(uiSnapshot.latestFill.kind, 'exit-fill');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    lifecycle: ['wallet-events', 'decision', 'paper-buy', 'tp1-50-percent', 'final-exit', 'persisted-result', 'ui-snapshot'],
    closedTradeCount: uiSnapshot.recentClosedTrades.length,
    startupModeAfterRestart: uiSnapshot.mode,
    autoRunAfterRestart: uiSnapshot.autoRun,
    realizedPnlSol: uiSnapshot.realizedPnlSol
  }, null, 2)}\n`);
}

if (require.main === module) runSmoke().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = { MemoryStore, runSmoke };
