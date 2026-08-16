'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig } = require('../src/default-config');
const { RefinedAuditWriter } = require('../src/refined-audit');
const { RefinedPaperEngine } = require('../src/refined-engine');

const WALLET = '11111111111111111111111111111111';
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
let now = 10_000_000;

function route(input, output) {
  return { ok: true, inputAmountAtomic: String(input), outAmountAtomic: String(output), minimumOutputAtomic: '', receivedAt: now, requestId: `smoke-${now}-${output}`, router: 'mock-jupiter-v2', routePlan: [], transactionPresent: false, feeAccountingComplete: false, signatureFeeLamports: '0', prioritizationFeeLamports: '0', rentFeeLamports: '0' };
}

const reverseOutputs = ['12000000', '6000000', '6000000', '4500000', '4500000', '4500000'];
const client = {
  // Priced so the default $14 target sizes to exactly 10,000,000 lamports (14 / 1400 * 1e9).
  async quoteSolUsd() { return { ok: true, price: '1400', observedAt: now, source: 'MOCK_SOL_USD' }; },
  async prepareEntry({ inputLamports }) {
    const entry = route(inputLamports, '1000000');
    // Reverse leg calibrated so a freshly-opened position clears the Fix 2 opening-basis
    // assertion (<=1.5%) at this fixture's fixed lamport fee floor.
    const reverse = route('1000000', '10300000');
    return { ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals: 6, conservativeTokenAtomic: '1000000', quotedTokenAtomic: '1000000', roundTripLossLamports: '500000', roundTripLossBps: 500 };
  },
  async quoteReverse({ tokenAmountAtomic }) { return route(tokenAmountAtomic, reverseOutputs.shift() || '5500000'); },
  status() { return { available: true, executionEnabled: false }; }
};

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-final-smoke-'));
  try {
    const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true, weight: 1 }], priceFallback: { enabled: false } });
    const auditWriter = new RefinedAuditWriter({ directory, clock: () => now });
    const engine = new RefinedPaperEngine({ config, auditWriter, jupiterClient: client, clock: () => now, waitImpl: async () => {} });
    const controlStartedAt = performance.now(); engine.setAutoRun(true); const controlLatencyMs = performance.now() - controlStartedAt;
    const entry = await engine.handleWalletSignal({ source: 'solana-rpc', wallet: WALLET, mint: MINT, side: 'buy', signature: 'smoke-buy', observedAt: now });
    assert.equal(entry.status, 'filled'); assert.equal(engine.state.positions[0].remainingTokenAmountAtomic, '996000');
    await engine._evaluatePosition(MINT);
    assert.equal(engine.state.positions[0].stage, 'AFTER_TP1'); assert.equal(engine.state.positions[0].remainingTokenAmountAtomic, '498000');
    await engine._evaluatePosition(MINT);
    assert.equal(engine.state.positions.length, 0); assert.equal(engine.state.closedTrades.length, 1);
    assert.equal(engine.reconcile().status, 'reconciled');
    const snapshot = engine.snapshot();
    assert.equal(snapshot.stats.closedTrades, 1); assert.equal(snapshot.stats.openPositions, 0);
    const trade = engine.state.closedTrades[0];
    assert.equal(trade.tp1Hit, true); assert.equal(trade.exitReason, 'RUNNER_TRAIL');
    assert.equal(BigInt(trade.netPnlLamports), BigInt(trade.exitProceedsLamports) - BigInt(trade.inputLamports) - BigInt(trade.feesLamports));
    assert.equal(BigInt(snapshot.stats.cashLamports), BigInt(engine.state.session.startingBalanceLamports) + BigInt(trade.netPnlLamports));
    assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('trades-')));
    process.stdout.write(`${JSON.stringify({ ok: true, strategy: snapshot.strategy, closedTrades: snapshot.stats.closedTrades, fills: snapshot.advanced.fillCount, controlLatencyMs, snapshotBuildMs: snapshot.responseBuildMs, memoryMb: snapshot.advanced.memoryMb, parity: snapshot.parity.fillQualities, auditFamilies: snapshot.advanced.audit.families })}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
