'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../src/default-config');
const { JupiterPaperExecutionAdapter } = require('../src/execution-adapters');
const { SOL_MINT } = require('../src/atomic');
const { SurvivorshipPaperEngine } = require('../src/survivorship-engine');
const { TrajectoryIndex } = require('../src/trajectory');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const W1 = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';
const W2 = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';

class AuditMemory {
  constructor() { this.events = []; this.quotes = []; this.fills = []; this.snapshots = []; this.outcomes = []; this.manifests = []; this.trades = []; }
  writeEvent(row) { this.events.push(structuredClone(row)); }
  writeQuote(row) { this.quotes.push(structuredClone(row)); }
  writeFill(row) { this.fills.push(structuredClone(row)); }
  writeSnapshot(row) { this.snapshots.push(structuredClone(row)); }
  writeOutcome(row) { this.outcomes.push(structuredClone(row)); }
  writeManifest(row) { this.manifests.push(structuredClone(row)); }
  writeV3Trade(row) { this.trades.push(structuredClone(row)); }
  status() { return { enabled: true, rowsWritten: {} }; }
}

function quote({ now, inputMint, outputMint, input, output, purpose }) {
  return {
    ok: true, outcome: 'ROUTE', purpose, inputMint, outputMint,
    inputAmountAtomic: String(input), outAmountAtomic: String(output), minimumOutputAtomic: '',
    requestId: `${purpose}-${input}`, router: 'fixture-router', mode: 'ExactIn',
    priceQuality: 'JUPITER_ROUTE_QUOTE', transactionPresent: false,
    requestedAt: now, receivedAt: now, requestTimestampUtc: new Date(now).toISOString(),
    responseTimestampUtc: new Date(now).toISOString(), latencyMs: 2, httpStatus: 200
  };
}

function harness() {
  let now = Date.parse('2026-08-14T12:00:00.000Z');
  const config = normalizeConfig({
    bot: { useGeneratedWallets: false },
    wallets: [{ address: W1, enabled: true, weight: 1 }, { address: W2, enabled: true, weight: 1 }],
    paper: { latencyMs: 0, networkFeeSol: 0.000005, priorityFeeSol: 0.0001 },
    priceFallback: { enabled: false },
    gmgn: { discoveryEnabled: false }
  });
  const audit = new AuditMemory();
  const client = {
    reverseHandler: (amount) => amount === '1000000000' ? '9900000' : amount === '500000000' ? '4950000' : '9900000',
    noEntryReverse: false,
    async prepareEntry({ outputMint, inputLamports }) {
      const entry = quote({ now, inputMint: SOL_MINT, outputMint, input: inputLamports, output: '1000000000', purpose: 'ENTRY' });
      if (this.noEntryReverse) return { ok: false, outcome: 'NO_SELL_ROUTE', entry, reverse: { ok: false, inputMint: outputMint, outputMint: SOL_MINT, inputAmountAtomic: '1000000000', receivedAt: now, errorCode: 'NO_ROUTE' }, tokenDecimals: 6, conservativeTokenAtomic: '1000000000' };
      const reverse = quote({ now, inputMint: outputMint, outputMint: SOL_MINT, input: '1000000000', output: '9900000', purpose: 'IMMEDIATE_REVERSE' });
      return { ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals: 6, conservativeTokenAtomic: '1000000000', quotedTokenAtomic: '1000000000', roundTripLossLamports: '100000', roundTripLossBps: 100 };
    },
    async quoteReverse({ mint, tokenAmountAtomic, purpose }) {
      const output = this.reverseHandler(String(tokenAmountAtomic), purpose);
      if (output == null) return { ok: false, outcome: 'NO_ROUTE', purpose, inputMint: mint, outputMint: SOL_MINT, inputAmountAtomic: String(tokenAmountAtomic), receivedAt: now, errorCode: 'NO_ROUTE' };
      return quote({ now, inputMint: mint, outputMint: SOL_MINT, input: tokenAmountAtomic, output, purpose });
    },
    status() { return { available: true, executionEnabled: false, successRatePct: 100, rateLimit: { tokens: 4, capacity: 4 } }; }
  };
  const engine = new SurvivorshipPaperEngine({ config, store: null, clock: () => now, trajectoryIndex: new TrajectoryIndex(), auditWriter: audit, sessionId: 'v3-test' });
  engine.setExecutionAdapters({ BOT_PAPER: new JupiterPaperExecutionAdapter({ engine, config, jupiterClient: client }) });
  engine.setAutoRun(true);
  return { audit, client, config, engine, now: () => now, advance: (ms) => { now += ms; } };
}

async function enter(h) {
  return h.engine.handleWalletSignal({ mint: MINT, wallet: W1, side: 'buy', signature: 'entry-sig', lifecycleStage: 'MIGRATED', slot: 123, commitment: 'processed', detectionLatencyMs: 17, observedAt: h.now() });
}

test('entry snapshot is deep-frozen and does not drift after a later wallet signal', async () => {
  const h = harness();
  assert.equal((await enter(h)).status, 'filled');
  const position = h.engine.state.bot.positions[MINT];
  const snapshot = h.engine.snapshots.get(position.snapshotId);
  const before = JSON.stringify(snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.signal.slot, 123);
  await h.engine.handleWalletSignal({ mint: MINT, wallet: W2, side: 'buy', signature: 'later-sig', observedAt: h.now() });
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(snapshot.wallet_count, 1);
  assert.equal(h.engine.state.bot.candidates[MINT].walletCount, 2);
});

test('features and reference marks timestamped after a decision are excluded', async () => {
  const h = harness();
  h.engine.setMarket({ mint: MINT, priceUsd: 1, liquidityUsd: 20_000, source: 'future-fixture', observedAt: h.now() + 1000 });
  assert.equal((await enter(h)).status, 'filled');
  const snapshot = h.engine.snapshots.get(h.engine.state.bot.positions[MINT].snapshotId);
  assert.equal(snapshot.reference_mark.available, false);
  assert.equal(snapshot.reference_mark.reason, 'AFTER_DECISION_EXCLUDED');
  assert.equal(snapshot.features.liquidity_usd.available, false);
  for (const item of Object.values(snapshot.features)) if (item.available) assert.ok(Date.parse(item.observed_at) <= Date.parse(snapshot.decision_timestamp_utc));
});

test('missing sell route removes stale executable profit and records unsellable after grace', async () => {
  const h = harness();
  await enter(h);
  const position = h.engine.state.bot.positions[MINT];
  assert.notEqual(position.currentNetValueLamports, null);
  h.client.reverseHandler = () => null;
  await h.engine._refreshPositionQuote(position);
  assert.equal(position.routeStatus, 'UNSELLABLE/NO_ROUTE');
  assert.equal(position.currentNetValueLamports, null);
  assert.equal(position.currentReturnPct, null);
  h.advance(h.config.jupiter.routeLossGraceMs + 1);
  await h.engine._refreshPositionQuote(position);
  assert.equal(position.conservativeValueLamports, '0');
  assert.equal(h.engine.state.v3.cohorts.UNSELLABLE, 1);
});

test('no immediate reverse route expires without creating a paper fill', async () => {
  const h = harness();
  h.client.noEntryReverse = true;
  assert.equal((await enter(h)).status, 'awaiting-quote');
  h.advance(h.config.bot.paperAggressive.priceWaitTimeoutSeconds * 1000 + 1);
  const result = await h.engine._considerEntry(MINT);
  assert.equal(result.status, 'expired');
  assert.equal(h.engine.state.lots.length, 0);
  assert.equal(h.engine.state.v3.cohorts.NO_SELL_ROUTE, 1);
});

test('permits only a linked re-entry after a new independent-wallet signal', async () => {
  const h = harness();
  await enter(h);
  const originalPositionId = h.engine.state.bot.positions[MINT].positionId;
  h.client.reverseHandler = () => '9000000';
  await h.engine._refreshPositionQuote(h.engine.state.bot.positions[MINT]);
  await h.engine._evaluateExit(MINT);
  assert.equal(h.engine.state.bot.positions[MINT], undefined);
  h.advance(h.config.bot.paperAggressive.reentryCooldownSeconds * 1000 + 1);
  const sameWallet = await h.engine.handleWalletSignal({ mint: MINT, wallet: W1, side: 'buy', signature: 'same-wallet-reentry', observedAt: h.now() });
  assert.equal(sameWallet.status, 'rejected');
  assert.match(sameWallet.reason, /new independent-wallet/i);
  h.client.reverseHandler = (amount) => amount === '1000000000' ? '9900000' : '4950000';
  const independent = await h.engine.handleWalletSignal({ mint: MINT, wallet: W2, side: 'buy', signature: 'independent-reentry', observedAt: h.now() });
  assert.equal(independent.status, 'filled');
  assert.equal(h.engine.state.bot.positions[MINT].originalPositionId, originalPositionId);
  assert.equal(h.engine.state.v3.reentriesByMint[MINT], 2);
});

test('paper lifecycle produces exact TP1/final fill arithmetic and a reconcilable trade row', async () => {
  const h = harness();
  await enter(h);
  h.client.reverseHandler = (amount) => amount === '1000000000' ? '12000000' : '6000000';
  let position = h.engine.state.bot.positions[MINT];
  await h.engine._refreshPositionQuote(position);
  await h.engine._evaluateExit(MINT);
  position = h.engine.state.bot.positions[MINT];
  assert.equal(position.tp1Complete, true);
  assert.equal(position.remainingTokenAmountAtomic, '500000000');
  h.client.reverseHandler = () => '8000000';
  await h.engine._refreshPositionQuote(position);
  await h.engine._evaluateExit(MINT);
  assert.equal(h.engine.state.bot.positions[MINT], undefined);
  assert.equal(h.audit.fills.length, 3);
  assert.equal(h.audit.trades.length, 1);
  const trade = h.audit.trades[0];
  const reconstructed = BigInt(trade.total_exit_proceeds_lamports) - BigInt(trade.entry_spend_lamports) - BigInt(trade.explicit_modelled_costs_lamports);
  assert.equal(reconstructed.toString(), trade.net_pnl_lamports);
  assert.equal(trade.total_exit_proceeds_lamports, '14000000');
  assert.equal(trade.explicit_modelled_costs_lamports, '315000');
  assert.equal(trade.net_pnl_lamports, '3685000');
  assert.deepEqual(h.audit.fills.map((fill) => fill.exit_stage), ['ENTRY', 'TP1', 'FINAL']);
});

test('counterfactual outcomes and open censoring never enter actual P&L', async () => {
  const h = harness();
  h.engine.setMarket({ mint: MINT, priceUsd: 1, source: 'reference', observedAt: h.now() });
  const startingBalance = h.engine.state.balanceLamports;
  const startingPnl = h.engine.state.realizedPnlSol;
  h.engine.recordOutcome('REJECTED', { mint: MINT, reason: 'fixture' });
  h.advance(5001);
  h.engine.setMarket({ mint: MINT, priceUsd: 2, source: 'reference', observedAt: h.now() });
  h.engine._sampleWatches();
  assert.equal(h.engine.state.balanceLamports, startingBalance);
  assert.equal(h.engine.state.realizedPnlSol, startingPnl);
  assert.ok(h.audit.outcomes.some((row) => row.horizon_ms === 5000 && row.actual_pnl_eligible === false));
  await enter(h);
  h.engine.stopAutomation();
  assert.equal(h.engine._robustStatistics().trades, 0);
  assert.equal(h.engine.state.v3.cohorts.OPEN_CENSORED, 1);
});
