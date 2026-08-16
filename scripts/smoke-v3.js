'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CsvAuditWriter } = require('../src/audit-writer');
const { normalizeConfig } = require('../src/default-config');
const { JupiterPaperExecutionAdapter } = require('../src/execution-adapters');
const { JupiterOrderClient } = require('../src/jupiter-client');
const { SurvivorshipPaperEngine } = require('../src/survivorship-engine');
const { TrajectoryIndex } = require('../src/trajectory');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';

async function runSmoke() {
  let now = Date.parse('2026-08-14T12:00:00.000Z');
  let phase = 'entry';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-v3-smoke-'));
  try {
    const config = normalizeConfig({
      bot: { useGeneratedWallets: false }, wallets: [{ address: WALLET, enabled: true, weight: 1 }],
      paper: { latencyMs: 0 }, priceFallback: { enabled: false }, gmgn: { discoveryEnabled: false },
      jupiter: { cacheMs: 0 }
    });
    const fetchImpl = async (url) => {
      const request = new URL(url);
      const inputMint = request.searchParams.get('inputMint');
      const amount = request.searchParams.get('amount');
      let outAmount = '1000000000';
      if (inputMint === MINT && phase === 'entry') outAmount = '9900000';
      if (inputMint === MINT && phase === 'tp1') outAmount = amount === '1000000000' ? '12000000' : '6000000';
      if (inputMint === MINT && phase === 'final') outAmount = '8000000';
      return { ok: true, status: 200, json: async () => ({ outAmount, requestId: `${phase}-${amount}`, router: 'offline-fixture', mode: 'ExactIn' }) };
    };
    const auditWriter = new CsvAuditWriter({ directory, clock: () => now });
    const engine = new SurvivorshipPaperEngine({ config, store: null, clock: () => now, trajectoryIndex: new TrajectoryIndex(), auditWriter, sessionId: 'offline-v3-smoke' });
    const jupiterClient = new JupiterOrderClient({ config, fetchImpl, clock: () => now, decimalsResolver: async () => 6 });
    engine.setExecutionAdapters({ BOT_PAPER: new JupiterPaperExecutionAdapter({ engine, config, jupiterClient }) });
    engine.setAutoRun(true);
    const entry = await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'smoke-entry', lifecycleStage: 'MIGRATED', slot: 1, commitment: 'processed', observedAt: now });
    assert.equal(entry.status, 'filled');

    now += 1000; phase = 'tp1';
    await engine._refreshPositionQuote(engine.state.bot.positions[MINT]);
    await engine._evaluateExit(MINT);
    assert.equal(engine.state.bot.positions[MINT].tp1Complete, true);

    now += 1000; phase = 'final';
    await engine._refreshPositionQuote(engine.state.bot.positions[MINT]);
    await engine._evaluateExit(MINT);
    assert.equal(engine.state.bot.positions[MINT], undefined);
    engine.stopAutomation();

    const reconciliation = auditWriter.reconcileV3('2026-08-14', 'offline-v3-smoke');
    assert.equal(reconciliation.reconciled, true);
    assert.equal(reconciliation.snapshots, 1);
    assert.equal(reconciliation.fills, 3);
    assert.equal(reconciliation.trades, 1);
    assert.equal(reconciliation.netPnlLamports, '3685000');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      paperOnly: true,
      lifecycle: ['logsSubscribe-style signal', 'exact entry quote', 'immediate reverse quote', 'paper buy', 'TP1 50%', 'final exit', 'ledger reconciliation'],
      ...reconciliation
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) runSmoke().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = { runSmoke };
