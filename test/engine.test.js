'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../src/default-config');
const { PaperEngine } = require('../src/engine');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET_A = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';
const WALLET_B = 'Dc9jiLSNN8qwEciwd55HmZhroswZ4XvcvKeRXHWCnwbP';

function makeEngine(overrides = {}) {
  const config = normalizeConfig({
    startingBalanceSol: 2,
    paper: {
      latencyMs: 0,
      slippageBps: 0,
      platformFeeBps: 0,
      networkFeeSol: 0,
      priorityFeeSol: 0,
      maxPriceAgeMs: 10_000
    },
    follow: {
      orderSolPerWallet: 0.02,
      acceptVisibleWalletsWhenListEmpty: true
    },
    priceFallback: { enabled: false },
    ...overrides
  });
  let now = 1_700_000_000_000;
  return {
    engine: new PaperEngine({ config, store: null, clock: () => now }),
    advance: (milliseconds) => { now += milliseconds; }
  };
}

test('follow mode mirrors one wallet from entry through its own exit', async () => {
  const { engine, advance } = makeEngine();
  engine.setMarket({ mint: MINT, priceUsd: 0.001, source: 'test' });
  engine.setFollow(true);
  const entry = await engine.handleSignal({
    id: 'entry-a', signature: 'sig-entry-a', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page'
  });
  assert.equal(entry.status, 'filled');
  assert.equal(engine.snapshot(MINT).position.followedWalletCount, 1);

  advance(5_000);
  engine.setMarket({ mint: MINT, priceUsd: 0.0015, source: 'test' });
  const exit = await engine.handleSignal({
    id: 'exit-a', signature: 'sig-exit-a', wallet: WALLET_A, mint: MINT, side: 'sell', source: 'gmgn-page'
  });
  assert.equal(exit.status, 'filled');
  assert.equal(engine.snapshot(MINT).position, null);
  assert.ok(engine.state.realizedPnlSol > 0.0099);
  assert.equal(engine.state.closedTrades[0].sourceWallet, WALLET_A);
  assert.equal(engine.state.closedTrades[0].entrySignature, 'sig-entry-a');
  assert.equal(engine.state.closedTrades[0].exitSignature, 'sig-exit-a');
});

test('a different wallet cannot close another wallet follow lot', async () => {
  const { engine } = makeEngine();
  engine.setMarket({ mint: MINT, priceUsd: 1, source: 'test' });
  engine.setFollow(true);
  await engine.handleSignal({ id: 'a-buy', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page' });
  const result = await engine.handleSignal({ id: 'b-sell', wallet: WALLET_B, mint: MINT, side: 'sell', source: 'gmgn-page' });
  assert.equal(result.status, 'unmatched-exit');
  assert.equal(engine.snapshot(MINT).position.lotCount, 1);
});

test('source-wallet partial exit closes the same fraction and keeps the rest live', async () => {
  const { engine } = makeEngine();
  engine.setMarket({ mint: MINT, priceUsd: 1, source: 'test' });
  engine.setFollow(true);
  await engine.handleSignal({ id: 'partial-buy', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page' });
  const before = engine.snapshot(MINT).position.remainingCostSol;
  await engine.handleSignal({ id: 'partial-sell', wallet: WALLET_A, mint: MINT, side: 'sell', fraction: 0.4, source: 'gmgn-page' });
  const after = engine.snapshot(MINT).position.remainingCostSol;
  assert.ok(Math.abs(after - before * 0.6) < 1e-10);
  assert.equal(engine.state.closedTrades[0].fraction, 0.4);
});

test('signals are logged but do not trade while FOLLOW is paused', async () => {
  const { engine } = makeEngine();
  engine.setMarket({ mint: MINT, priceUsd: 1, source: 'test' });
  const result = await engine.handleSignal({ id: 'paused-buy', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page' });
  assert.equal(result.status, 'observed');
  assert.equal(engine.state.lots.length, 0);
  assert.equal(engine.state.activity[0].kind, 'signal');
});

test('paper fill math includes configured slippage and fixed costs', () => {
  const { engine } = makeEngine({
    paper: {
      latencyMs: 0,
      slippageBps: 100,
      platformFeeBps: 100,
      networkFeeSol: 0.001,
      priorityFeeSol: 0.002,
      maxPriceAgeMs: 10_000
    }
  });
  engine.setMarket({ mint: MINT, priceUsd: 2, source: 'test' });
  const result = engine.manualBuy({ mint: MINT, amountSol: 1 });
  assert.equal(result.status, 'filled');
  assert.equal(result.fill.executionPriceUsd, 2.02);
  assert.ok(Math.abs(result.fill.feesSol - 0.013) < 1e-12);
  assert.ok(Math.abs(engine.state.balanceSol - 0.997) < 1e-12);
});

test('uses token/SOL price when available instead of assuming SOL/USD is fixed', () => {
  const { engine } = makeEngine();
  engine.setMarket({ mint: MINT, priceUsd: 1, priceSol: 0.01, source: 'test' });
  engine.manualBuy({ mint: MINT, amountSol: 1 });
  engine.setMarket({ mint: MINT, priceUsd: 1, priceSol: 0.02, source: 'test' });
  const position = engine.snapshot(MINT).position;
  assert.ok(Math.abs(position.estimatedValueSol - 2) < 1e-10);
  assert.ok(Math.abs(position.unrealizedPnlSol - 1) < 1e-10);
});

test('a signal arriving before price is filled when a fresh price appears', async () => {
  const { engine } = makeEngine();
  engine.setFollow(true);
  const result = await engine.handleSignal({ id: 'late-price', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page' });
  assert.equal(result.status, 'awaiting-price');
  assert.equal(engine.state.lots.length, 0);
  engine.setMarket({ mint: MINT, priceUsd: 1, source: 'test' });
  assert.equal(engine.state.lots.length, 1);
});

test('pausing FOLLOW cancels a queued delayed fill', async () => {
  const { engine } = makeEngine({ paper: { latencyMs: 20, maxPriceAgeMs: 10_000 } });
  engine.setMarket({ mint: MINT, priceUsd: 1, source: 'test' });
  engine.setFollow(true);
  const pending = engine.handleSignal({ id: 'queued-buy', wallet: WALLET_A, mint: MINT, side: 'buy', source: 'gmgn-page' });
  engine.setFollow(false);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(engine.state.lots.length, 0);
});
