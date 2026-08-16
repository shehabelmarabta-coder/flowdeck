'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig } = require('../src/default-config');
const { RefinedAuditWriter } = require('../src/refined-audit');
const { FILL_QUALITY, RefinedPaperEngine, STATE_SCHEMA } = require('../src/refined-engine');
const { dynamicStop, tightenStop } = require('../src/risk-model');

const WALLET = '11111111111111111111111111111111';
const WALLET_2 = '22222222222222222222222222222222';
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

class MemoryStore {
  constructor(value = null) { this.value = value; }
  loadState() { return this.value == null ? null : JSON.parse(JSON.stringify(this.value)); }
  saveState(value) { this.value = JSON.parse(JSON.stringify(value)); }
}

function quote(inputAmountAtomic, outAmountAtomic, now, overrides = {}) {
  // A real Jupiter quote always carries a real otherAmountThreshold; default one here (2% below
  // outAmount) instead of leaving it empty, so it comfortably clears the ~1.4% modelled-fill
  // slippage (priceImpactPct 1% + realisticSlippageBps 40bps) this fixture's quotes use by
  // default. Tests exercising WOULD_FAIL_SLIPPAGE still pass their own explicit floor.
  const defaultMinimumOutput = (BigInt(outAmountAtomic) * 98n / 100n).toString();
  return {
    ok: true, outcome: 'ROUTE', inputAmountAtomic: String(inputAmountAtomic), outAmountAtomic: String(outAmountAtomic),
    minimumOutputAtomic: defaultMinimumOutput, receivedAt: now, requestedAt: now, requestId: `request-${outAmountAtomic}`, router: 'mock-router',
    routePlan: [{ swapInfo: { label: 'mock' } }], priceImpactPct: '0.01', transactionPresent: false, transaction: null,
    feeAccountingComplete: false, signatureFeeLamports: '0', prioritizationFeeLamports: '0', ...overrides
  };
}

function assessment(now, overrides = {}) {
  const entry = overrides.entry || quote('10000000', overrides.entryOut || '1000000', now);
  // Default reverse leg is calibrated so a freshly-opened position clears the Fix 2
  // opening-basis assertion (<=1.5%) at this fixture's small 0.01 SOL test scale, where the
  // harness's fixed lamport fees (network+priority, ~2.1% of input here) would otherwise
  // dominate a realistic-looking round-trip spread. Tests that need a specific round-trip
  // loss pass their own reverseOut/reverse override.
  const reverse = overrides.reverse || quote(entry.outAmountAtomic, overrides.reverseOut || '10400000', now);
  return {
    ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals: 6,
    conservativeTokenAtomic: String(overrides.tokenAmount || entry.outAmountAtomic), quotedTokenAtomic: entry.outAmountAtomic,
    roundTripLossLamports: String(10_000_000n - BigInt(reverse.outAmountAtomic)), roundTripLossBps: 500,
    ...overrides, entry, reverse
  };
}

class MockJupiter {
  constructor(now) { this.now = now; this.prepareQueue = []; this.reverseQueue = []; this.prepareCalls = []; this.reverseCalls = []; }
  async prepareEntry(args) {
    this.prepareCalls.push({ ...args });
    const next = this.prepareQueue.length ? this.prepareQueue.shift() : assessment(this.now);
    return typeof next === 'function' ? next(args) : next;
  }
  async quoteReverse(args) {
    this.reverseCalls.push({ ...args });
    const next = this.reverseQueue.length ? this.reverseQueue.shift() : quote(args.tokenAmountAtomic, '9500000', this.now);
    return typeof next === 'function' ? next(args) : next;
  }
  // Priced so the default $14 target sizes to exactly 10,000,000 lamports (14 / 1400 * 1e9),
  // matching every hardcoded '10000000' entry quote fixture in this file unchanged.
  async quoteSolUsd() { return { ok: true, price: '1400', observedAt: this.now, source: 'MOCK_SOL_USD' }; }
  status() { return { available: true, executionEnabled: false }; }
}

function harness(overrides = {}) {
  let now = overrides.now ?? 1_000_000;
  const config = normalizeConfig({
    startingBalanceSol: overrides.startingBalanceSol ?? 2,
    paper: { networkFeeSol: 0.000005, priorityFeeSol: 0.0001 },
    bot: { paperAggressive: { orderSol: 0.01, maxOpenPositions: 20 }, refined: overrides.refined || {} },
    wallets: [{ address: WALLET, enabled: true, weight: 1 }, { address: WALLET_2, enabled: true, weight: 1 }],
    priceFallback: { enabled: false }
  });
  const client = overrides.client || new MockJupiter(now);
  const store = overrides.store === undefined ? new MemoryStore() : overrides.store;
  const engine = new RefinedPaperEngine({
    config, store, auditWriter: overrides.auditWriter || null, jupiterClient: client, simulator: overrides.simulator || null,
    clock: () => now, waitImpl: async (milliseconds) => { if (overrides.advanceDelay) now += milliseconds; }
  });
  return { config, client, engine, store, now: () => now, advance: (milliseconds) => { now += milliseconds; client.now = now; } };
}

async function enter(h, signature = 'signal-1') {
  h.engine.setAutoRun(true);
  return h.engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature, source: 'solana-rpc', observedAt: h.now() });
}

test('FlowDeck final deterministic acceptance matrix', async (t) => {
  await t.test('1. one enabled-wallet buy creates a candidate and immediate paper fill', async () => {
    const h = harness(); const result = await enter(h);
    assert.equal(result.status, 'filled'); assert.equal(h.engine.state.candidates.length, 1); assert.equal(h.engine.state.positions.length, 1);
  });

  await t.test('2. duplicate wallet trade cannot create duplicate positions', async () => {
    const h = harness(); await enter(h, 'same');
    const duplicate = await h.engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'same' });
    assert.equal(duplicate.status, 'duplicate'); assert.equal(h.engine.state.positions.length, 1);
  });

  await t.test('3. paper and live share the required ExecutionIntent fields', async () => {
    const h = harness(); await enter(h); const intent = h.engine.state.intents[0];
    for (const key of ['decisionId', 'mint', 'side', 'inputAmountAtomic', 'walletEvidence', 'decisionTimestamp', 'initialQuote', 'minimumOutputAtomic', 'route', 'priceImpactPct', 'plannedExecutionDelayMs', 'stopModel', 'tp1Policy', 'runnerPolicy', 'mode', 'status']) assert.ok(key in intent, key);
    assert.equal(intent.mode, 'BOT_PAPER'); assert.equal(h.engine.setMode('BOT_LIVE').status, 'blocked');
  });

  await t.test('4. entry uses a fresh exact-sized revalidation after the measured delay', async () => {
    const h = harness(); await enter(h);
    assert.equal(h.client.prepareCalls.length, 2); assert.ok(h.client.prepareCalls.every((call) => call.inputLamports === '10000000' && call.fresh === true));
    assert.ok(h.engine.state.intents[0].plannedExecutionDelayMs >= 250 && h.engine.state.intents[0].plannedExecutionDelayMs <= 2000);
  });

  await t.test('5. all execution quantities remain exact atomic strings', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    assert.equal(position.inputLamports, '10000000'); assert.equal(position.initialTokenAmountAtomic, '986000'); assert.match(position.remainingTokenAmountAtomic, /^\d+$/);
  });

  await t.test('6. stale revalidation quote is rejected', async () => {
    const h = harness(); h.client.prepareQueue.push(assessment(h.now()), assessment(h.now() - 10_000));
    const result = await enter(h); assert.equal(result.reason, 'STALE_QUOTE'); assert.equal(h.engine.state.positions.length, 0);
  });

  await t.test('7. slippage breach produces NO_FILL', async () => {
    const h = harness();
    h.client.prepareQueue.push(assessment(h.now(), { entry: quote('10000000', '1000000', h.now(), { minimumOutputAtomic: '990000' }) }), assessment(h.now(), { entryOut: '980000', tokenAmount: '980000' }));
    const result = await enter(h); assert.equal(result.reason, 'WOULD_FAIL_SLIPPAGE'); assert.equal(result.fillQuality, FILL_QUALITY.NO_FILL);
  });

  await t.test('8. deterministic simulation program error produces NO_FILL', async () => {
    const built = assessment(1_000_000, { entry: quote('10000000', '1000000', 1_000_000, { transactionPresent: true, transaction: 'base64' }) });
    const h = harness({ simulator: async () => ({ classification: 'DETERMINISTIC_ERROR', reason: 'program error' }) }); h.client.prepareQueue.push(built);
    const result = await enter(h); assert.equal(result.reason, 'DETERMINISTIC_SIMULATION_ERROR'); assert.equal(h.engine.state.positions.length, 0);
  });

  await t.test('9. buildable paper-wallet-state-only simulation remains honestly unsimulated', async () => {
    const built = assessment(1_000_000, { entry: quote('10000000', '1000000', 1_000_000, { transactionPresent: true, transaction: 'base64' }) });
    const h = harness({ simulator: async () => ({ classification: 'PAPER_STATE_ONLY', reason: 'AccountNotFound' }) }); h.client.prepareQueue.push(built, built);
    const result = await enter(h); assert.equal(result.fillQuality, FILL_QUALITY.BUILDABLE_UNSIMULATED); assert.equal(h.engine.state.positions.length, 1);
  });

  await t.test('10. no-route candidate never becomes a position', async () => {
    const h = harness(); h.client.prepareQueue.push({ ok: false, outcome: 'NO_ENTRY_ROUTE', entry: { ok: false, errorCode: 'NO_ROUTE' }, reverse: null });
    const result = await enter(h); assert.equal(result.status, 'no-fill'); assert.equal(h.engine.state.positions.length, 0);
  });

  await t.test('11. partial and full exits request their exact reverse atomic quantities', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    h.client.reverseQueue.push(quote('493000', '6000000', h.now()), quote('493000', '6000000', h.now()));
    await h.engine._withLock(MINT, () => h.engine._executeExit(position, '493000', 'TEST_PARTIAL'));
    h.client.reverseQueue.push(quote('493000', '6000000', h.now()), quote('493000', '6000000', h.now()));
    await h.engine._withLock(MINT, () => h.engine._executeExit(position, position.remainingTokenAmountAtomic, 'TEST_FULL'));
    assert.deepEqual(h.client.reverseCalls.slice(-4).map((call) => call.tokenAmountAtomic), ['493000', '493000', '493000', '493000']); assert.equal(h.engine.state.positions.length, 0);
  });

  await t.test('12. missing sell route marks the position temporarily unsellable', async () => {
    const h = harness(); await enter(h); h.client.reverseQueue.push({ ok: false, errorCode: 'NO_ROUTE' });
    const result = await h.engine._evaluatePosition(MINT); assert.equal(result.status, 'temporarily-unsellable'); assert.equal(h.engine.state.positions[0].status, 'TEMPORARILY_UNSELLABLE');
  });

  await t.test('13. a low-volatility liquid coin receives a tighter stop', () => {
    const h = harness({ refined: { maxLossSol: 1 } });
    const low = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', volatility: 1 });
    assert.equal(low.stopPct, 8);
  });

  await t.test('14. higher volatility produces a wider but bounded stop', () => {
    const h = harness({ refined: { maxLossSol: 1 } });
    const low = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', volatility: 1 });
    const high = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', volatility: 6 });
    assert.ok(high.stopPct > low.stopPct); assert.ok(high.stopPct <= 20);
  });

  await t.test('15. insufficient volatility/history evidence uses the 12% fallback', () => {
    const h = harness({ refined: { maxLossSol: 1 } });
    const risk = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', volatility: null, closedTrades: [] });
    assert.equal(risk.stopPct, 12); assert.equal(risk.fallbackApplied, true); assert.equal(risk.evidence, 'FALLBACK_INSUFFICIENT_EVIDENCE');
  });

  await t.test('16. a frozen stop may tighten but never widen', () => {
    assert.equal(tightenStop({ frozenStopPct: 12, currentStopPct: 9, mfePct: 2, breakevenMfePct: 8 }), 9);
    assert.equal(tightenStop({ frozenStopPct: 12, currentStopPct: 9, mfePct: 8, breakevenMfePct: 8 }), 0);
  });

  await t.test('17. excessive required stop is RISK_TOO_WIDE', () => {
    const h = harness({ refined: { maxLossSol: 1, maxStopPct: 20 } });
    const risk = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', volatility: 11 });
    assert.equal(risk.rejectReason, 'RISK_TOO_WIDE'); assert.ok(risk.rawStopPct > 20);
  });

  await t.test('18. absolute maxLossSol is enforced without variable sizing', () => {
    const h = harness({ refined: { maxLossSol: 0.0009 } });
    const risk = dynamicStop({ config: h.config, inputLamports: '10000000', immediateReverseLamports: '10000000', entryFeeLamports: '200000', exitFeeLamports: '200000', volatility: 2 });
    assert.equal(risk.rejectReason, 'MAX_LOSS_EXCEEDED'); assert.equal(risk.sizedInputLamports, '10000000');
  });

  await t.test('19. TP1 sells exactly 50% of the atomic token balance', async () => {
    const h = harness(); await enter(h); h.client.reverseQueue.push(quote('986000', '12000000', h.now()), quote('493000', '6000000', h.now()), quote('493000', '6000000', h.now()));
    await h.engine._evaluatePosition(MINT); const position = h.engine.state.positions[0];
    assert.equal(position.remainingTokenAmountAtomic, '493000'); assert.equal(position.tp1.hit, true); assert.equal(h.client.reverseCalls.at(-1).tokenAmountAtomic, '493000');
  });

  await t.test('20. runner exits when net executable PnL crosses its volatility trail floor', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0]; position.tp1.hit = true; position.stage = 'AFTER_TP1'; position.mfePct = 20; position.runnerPolicy.trailPct = 6;
    h.client.reverseQueue.push(quote('1000000', '11500000', h.now()), quote('1000000', '11500000', h.now()), quote('1000000', '11500000', h.now()));
    await h.engine._evaluatePosition(MINT); assert.equal(h.engine.state.positions.length, 0); assert.equal(h.engine.state.closedTrades.at(-1).exitReason, 'RUNNER_TRAIL');
  });

  await t.test('21. maximum hold forces a route-validated exit', async () => {
    const h = harness(); await enter(h); h.advance(31 * 60_000);
    h.client.reverseQueue.push(quote('1000000', '10300000', h.now()), quote('1000000', '10300000', h.now()), quote('1000000', '10300000', h.now()));
    await h.engine._evaluatePosition(MINT); assert.equal(h.engine.state.closedTrades.at(-1).exitReason, 'PRE_TP1_MAX_HOLD');
  });

  await t.test('22. reset closes positions, preserves CSV history, and starts a clean session', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-03r-audit-'));
    try {
      const writer = new RefinedAuditWriter({ directory }); const h = harness({ auditWriter: writer }); await enter(h); const oldSession = h.engine.state.session.id;
      h.client.reverseQueue.push(quote('1000000', '10000000', h.now()), quote('1000000', '10000000', h.now()));
      const result = await h.engine.reset(); assert.notEqual(result.sessionId, oldSession); assert.equal(h.engine.state.positions.length, 0); assert.ok(h.engine.state.closedTrades.length === 1);
      assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('trades-')));
      // RESET SESSION: the previous session's trade is archived on disk and in closedTrades
      // history (wallet-ranking etc still see it), but current-session UI reads must not.
      const snapshot = h.engine.snapshot();
      assert.equal(snapshot.recentClosedTrades.length, 0);
      assert.equal(snapshot.stats.closedTrades, 0);
      assert.equal(snapshot.stats.wins, 0);
      // The only activity entry a fresh session may legitimately start with is its own
      // NEW_SESSION marker - no old candidate/signal/fill events from the closed session.
      assert.ok(snapshot.recentActivity.every((event) => event.type === 'NEW_SESSION'));
      assert.equal(snapshot.recentCandidates.length, 0);
      assert.equal(snapshot.session.balanceLamports, snapshot.session.startingBalanceLamports);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  await t.test('23. UI counters reconcile to the authoritative ledger and snapshot stays under budget', async () => {
    const h = harness(); await enter(h); const started = performance.now(); const snapshot = h.engine.snapshot(); const elapsed = performance.now() - started;
    assert.equal(snapshot.stats.openPositions, h.engine.state.positions.length); assert.equal(snapshot.advanced.fillCount, h.engine.state.fills.length); assert.ok(elapsed < 100);
  });

  await t.test('24. a legacy v0.2 state file cannot appear as an active 0.3R position', () => {
    const legacy = new MemoryStore({ schemaVersion: 'flowdeck-v02', positions: [{ id: 'legacy-position', mint: MINT }] });
    const h = harness({ store: legacy }); assert.equal(h.engine.state.schemaVersion, STATE_SCHEMA); assert.equal(h.engine.state.positions.length, 0);
  });

  await t.test('25. production runtime has no universe, research, or counterfactual engine loop', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.doesNotMatch(serverSource, /SurvivorshipPaperEngine|Counterfactual|ResearchEngine/); const h = harness(); h.engine.startAutomation(); assert.ok(h.engine.timer); h.engine.stopAutomation();
  });

  await t.test('26. restart persistence cannot duplicate an open position or fill', async () => {
    const store = new MemoryStore(); const first = harness({ store }); await enter(first); const positionId = first.engine.state.positions[0].id; const fillId = first.engine.state.fills[0].id;
    const second = harness({ store }); assert.equal(second.engine.state.autoRun, true); assert.deepEqual(second.engine.state.positions.map((item) => item.id), [positionId]); assert.deepEqual(second.engine.state.fills.map((item) => item.id), [fillId]);
  });

  await t.test('27. buildable accepted simulation with complete fees is SIMULATED_BUILDABLE', async () => {
    const built = assessment(1_000_000, { entry: quote('10000000', '1000000', 1_000_000, { transactionPresent: true, transaction: 'base64', feeAccountingComplete: true, signatureFeeLamports: '5000', prioritizationFeeLamports: '100000', rentFeeLamports: '0' }) });
    const h = harness({ simulator: async () => ({ classification: 'ACCEPTABLE', unitsConsumed: 100000 }) }); h.client.prepareQueue.push(built, built);
    const result = await enter(h); assert.equal(result.fillQuality, FILL_QUALITY.SIMULATED_BUILDABLE);
  });

  await t.test('28. Fix 1: paper fills price at the modelled quote (priceImpact + realistic slippage bps), not the raw quote and not the protection floor', async () => {
    const h = harness();
    const entry = quote('10000000', '1000000', h.now(), { priceImpactPct: '0.02', minimumOutputAtomic: '900000' });
    h.client.prepareQueue.push(assessment(h.now(), { entry }), assessment(h.now(), { entry }));
    const result = await enter(h);
    assert.equal(result.status, 'filled');
    const position = h.engine.state.positions[0];
    // modelled = out * (1 - (priceImpactBps 200 + realisticSlippageBps 40) / 10000) = 1,000,000 * 0.976
    assert.equal(position.initialTokenAmountAtomic, '976000');
    assert.notEqual(position.initialTokenAmountAtomic, '1000000');
    assert.notEqual(position.initialTokenAmountAtomic, '900000');
  });

  await t.test('29. Fix 2: legitimate risk-approved meme friction fills instead of throwing POSITION_OPENED_OFF_BASIS, while genuinely extreme friction still rejects cleanly via risk', async () => {
    // dynamicStop() and the opening-basis check both price off the same revalidated reverse
    // quote, so once risk approves a stop budget the fill's opening basis is mathematically
    // guaranteed to fall inside it. The old fixed 1.5% invariant was rejecting this exact
    // legitimate, risk-approved meme friction with a raw INTERNAL_EXECUTION_ERROR; genuinely
    // extreme friction (past maxStopPct) still correctly rejects, but via RISK_TOO_WIDE before
    // a fill is ever attempted, not via a basis-check crash.
    const moderate = harness();
    const moderateReverse = quote('1000000', '8200000', moderate.now()); // ~18% round-trip friction, inside maxStopPct 30%
    moderate.client.prepareQueue.push(assessment(moderate.now(), { reverse: moderateReverse }), assessment(moderate.now(), { reverse: moderateReverse }));
    const moderateResult = await enter(moderate);
    assert.equal(moderateResult.status, 'filled');
    assert.equal(moderate.engine.state.positions.length, 1);

    const extreme = harness();
    const extremeReverse = quote('1000000', '6000000', extreme.now()); // ~40% friction, past maxStopPct 30%
    extreme.client.prepareQueue.push(assessment(extreme.now(), { reverse: extremeReverse }), assessment(extreme.now(), { reverse: extremeReverse }));
    const extremeResult = await enter(extreme);
    assert.equal(extremeResult.status, 'no-fill');
    assert.equal(extremeResult.reason, 'RISK_TOO_WIDE');
    assert.equal(extreme.engine.state.positions.length, 0);
  });

  await t.test('30. Fix 3: the dynamic stop cannot fire inside the arming window even if the mark already collapsed', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    h.client.reverseQueue.push(quote('986000', '1000000', h.now()));
    await h.engine._evaluatePosition(MINT);
    assert.equal(h.engine.state.positions.length, 1, 'must not stop out inside the arming window');
    assert.equal(position.stopArmedAt, null);
    h.advance(6000);
    h.client.reverseQueue.push(quote('986000', '1000000', h.now()), quote('986000', '1000000', h.now()), quote('986000', '1000000', h.now()));
    await h.engine._evaluatePosition(MINT);
    assert.equal(h.engine.state.positions.length, 0, 'stop must fire once armed');
  });

  await t.test('31. PROFIT_LOCK arms once net executable return first reaches +20%, with a positive (not merely breakeven) floor', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    position.tp1.hit = true; position.runnerPolicy.trailPct = 6;
    h.client.reverseQueue.push(quote('1000000', '12500000', h.now())); // ~21% net executable return
    await h.engine._evaluatePosition(MINT);
    assert.equal(position.profitLockArmed, true);
    assert.ok(position.profitLockFloorPct > 0, 'the armed floor must protect a positive profit, not just breakeven');
    assert.equal(h.engine.state.positions.length, 1, 'must not exit on the same tick it arms');
  });

  await t.test('32. PROFIT_LOCK keeps trailing upward and never exits a runner that keeps making new highs (GUNICORN case: +21% -> +58%)', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    position.tp1.hit = true; position.runnerPolicy.trailPct = 6;
    let previousFloor = -Infinity;
    for (const out of ['12500000', '13000000', '15000000', '16500000']) {
      h.client.reverseQueue.push(quote('1000000', out, h.now()));
      await h.engine._evaluatePosition(MINT);
      assert.equal(h.engine.state.positions.length, 1, `must still be running at reverse-quote output ${out}`);
      assert.ok(position.profitLockFloorPct >= previousFloor, 'the floor must trail upward, never retreat');
      previousFloor = position.profitLockFloorPct;
    }
    assert.ok(position.mfePct > 55, 'must have been allowed to run close to the +58% GUNICORN outcome');
  });

  await t.test('33. PROFIT_LOCK exits positive on a reversal after a big run, instead of collapsing to a loss (BLACKHOLE case: +45% -> crash)', async () => {
    const h = harness(); await enter(h); const position = h.engine.state.positions[0];
    position.tp1.hit = true; position.runnerPolicy.trailPct = 6;
    h.client.reverseQueue.push(quote('1000000', '15000000', h.now())); // climb to ~46% MFE, arming and trailing the floor
    await h.engine._evaluatePosition(MINT);
    assert.equal(h.engine.state.positions.length, 1);
    assert.ok(position.profitLockFloorPct > 20, 'floor should have trailed up well past the +20% arming point');
    // Reversal to ~21%, still positive but below the trailed floor. The triggering mark plus
    // _executeExit's own initial-and-revalidation reverse quotes are 3 separate calls (same
    // pattern as every other exit path in this file), so all three need the crash fixture.
    h.client.reverseQueue.push(quote('1000000', '12500000', h.now()), quote('1000000', '12500000', h.now()), quote('1000000', '12500000', h.now()));
    await h.engine._evaluatePosition(MINT);
    assert.equal(h.engine.state.positions.length, 0);
    const trade = h.engine.state.closedTrades.at(-1);
    assert.equal(trade.exitReason, 'PROFIT_LOCK');
    assert.ok(trade.netPnlPct > 0, 'must bank a profit instead of collapsing to a loss like the old breakeven-only floor allowed');
  });
});
