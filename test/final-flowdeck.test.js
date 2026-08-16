'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../src/default-config');
const { GmgnResearchProvider } = require('../src/gmgn-market-provider');
const { RefinedPaperEngine } = require('../src/refined-engine');
const { firstFilter, tokenIdentity } = require('../src/token-research');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const MINT_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = '11111111111111111111111111111111';
const WALLET_2 = '22222222222222222222222222222222';

function config(overrides = {}) {
  return normalizeConfig({
    ...overrides,
    wallets: [{ address: WALLET, enabled: true, weight: 1 }, { address: WALLET_2, enabled: true, weight: 1 }]
  });
}

function quote(input, output, now = 1_000_000) {
  return {
    ok: true, outcome: 'ROUTE', inputAmountAtomic: String(input), outAmountAtomic: String(output), minimumOutputAtomic: '',
    receivedAt: now, requestedAt: now, requestId: `q-${output}`, router: 'mock', routePlan: [], transactionPresent: false,
    feeAccountingComplete: false, signatureFeeLamports: '0', prioritizationFeeLamports: '0', rentFeeLamports: '0'
  };
}

function routable(input = '10000000', now = 1_000_000) {
  const entry = quote(input, '1000000', now);
  // Reverse leg is calibrated so a freshly-opened position clears the Fix 2 opening-basis
  // assertion (<=1.5%) at this fixture's fixed lamport fee floor (see refined-v03r.test.js
  // for the same calibration note).
  const reverse = quote('1000000', (BigInt(input) * 103n / 100n).toString(), now);
  return {
    ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals: 6, conservativeTokenAtomic: '1000000',
    conservativeReverseLamports: reverse.outAmountAtomic, quotedTokenAtomic: '1000000', roundTripLossLamports: (BigInt(input) - BigInt(reverse.outAmountAtomic)).toString(), roundTripLossBps: 300
  };
}

function research(identity = { mint: MINT, symbol: 'TEST', name: 'Test Token', source: 'GMGN' }, unavailable = false) {
  return {
    mint: MINT, identity, unavailable, unavailableReasons: unavailable ? ['MOCK_PARTIAL'] : [], observedAt: 1_000_000,
    info: { name: identity.name, symbol: identity.symbol, liquidity: 50_000 }, pool: { liquidity: 50_000 }, candles: [],
    security: { renounced_mint: true, renounced_freeze_account: true, is_wash_trading: false, rug_ratio: 0.1, top_10_holder_rate: 0.2 }
  };
}

function researchProvider(value) {
  return {
    async inspectMint() { return value; },
    classify(item, { reverseRouteAvailable }) {
      const filter = firstFilter({ ...item, reverseRouteAvailable });
      return item.unavailable && filter.result !== 'REJECT'
        ? { ...filter, result: 'NEEDS_DEEPER_RESEARCH', reason: 'INCOMPLETE_GMGN_EVIDENCE', flags: [...new Set([...(filter.flags || []), 'INCOMPLETE_GMGN_EVIDENCE'])] }
        : filter;
    },
    status() { return { ready: true }; }
  };
}

test('dynamic $14 sizing follows the current Jupiter SOL/USD route', async () => {
  for (const [price, expected] of [['100', '140000000'], ['250', '56000000'], ['500', '28000000']]) {
    const engine = new RefinedPaperEngine({
      config: config(),
      jupiterClient: { async quoteSolUsd() { return { ok: true, price, observedAt: 1_000_000, source: 'MOCK_SOL_USD' }; } },
      clock: () => 1_000_000
    });
    const sizing = await engine._resolveSizing();
    assert.equal(sizing.inputLamports, expected);
    assert.equal(sizing.targetUsd, 14);
    assert.equal(sizing.mode, 'USD_TARGET');
  }
});

test('stale, backfilled and paused signals cannot execute after resume', async () => {
  let prepareCalls = 0;
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { prepareCalls += 1; return routable(); }, status() { return {}; }
  };
  const engine = new RefinedPaperEngine({ config: config(), jupiterClient: client, clock: () => 1_000_000, waitImpl: async () => {} });
  assert.equal((await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'old', observedAt: 969_999 })).status, 'expired');
  assert.equal((await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'backfill', observedAt: 1_000_000, backfilled: true })).reason, 'backfill-evidence-only');
  engine.setAutoRun(false);
  assert.equal((await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'paused', observedAt: 1_000_000 })).status, 'expired');
  engine.setAutoRun(true);
  assert.equal(prepareCalls, 0);
  assert.equal(engine.state.positions.length, 0);
});

test('the existing symbol/name keyword blacklist rejects a candidate before it can fill', async () => {
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return routable(); }, status() { return {}; }
  };
  const engine = new RefinedPaperEngine({
    config: config(),
    jupiterClient: client,
    researchProvider: researchProvider(research({ mint: MINT, symbol: 'USOR', name: 'usor coin', source: 'GMGN' })),
    clock: () => 1_000_000, waitImpl: async () => {}
  });
  const result = await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'kw-1', observedAt: 1_000_000 });
  assert.match(result.reason, /BLACKLISTED_IDENTITY/);
  assert.equal(engine.state.positions.length, 0);
});

test('a distinct fresh wallet strengthens one waiting mint candidate', async () => {
  const queue = [{ ok: false, outcome: 'RATE_LIMITED' }, routable(), routable()];
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return queue.shift(); }, status() { return {}; }
  };
  const engine = new RefinedPaperEngine({ config: config(), jupiterClient: client, clock: () => 1_000_000, waitImpl: async () => {} });
  assert.equal((await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'a', observedAt: 1_000_000 })).status, 'waiting');
  assert.equal((await engine.handleWalletSignal({ mint: MINT, wallet: WALLET_2, side: 'buy', signature: 'b', observedAt: 1_000_000 })).status, 'filled');
  assert.equal(engine.state.candidates.length, 1);
  assert.equal(engine.state.candidates[0].sourceWallets.length, 2);
  assert.equal(engine.state.intents.at(-1).mathematics.brain.distinctFreshWallets, 2);
  engine.stopAutomation();
});

test('FlowDeck Lite: followed-wallet roster replaces the roster, deduplicates, rejects invalid addresses, and leaves the prior roster (the 40-wallet fallback) intact on failed extraction', () => {
  const engine = new RefinedPaperEngine({ config: config(), clock: () => 1_000_000 });
  const updated = engine.setFollowedWallets([WALLET, WALLET, WALLET_2, 'not-a-real-address']);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.count, 2);
  assert.equal(engine.config.wallets.length, 2);
  assert.equal(new Set(engine.config.wallets.map((wallet) => wallet.address)).size, 2);

  const failedExtraction = engine.setFollowedWallets([]);
  assert.equal(failedExtraction.status, 'ignored');
  assert.equal(engine.config.wallets.length, 2, 'roster from the last successful extraction (or the 40-wallet fallback) must survive a failed extraction');
});

test('FlowDeck Lite: one followed wallet alone can trade; 4+ distinct followed wallets converging on one mint reach STRONG confidence', async () => {
  const WALLET_3 = '33333333333333333333333333333333';
  const WALLET_4 = '44444444444444444444444444444444';
  const cfg = normalizeConfig({ wallets: [WALLET, WALLET_2, WALLET_3, WALLET_4].map((address) => ({ address, enabled: true, weight: 1 })) });
  const baseClient = { async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; }, status() { return {}; } };

  const solo = new RefinedPaperEngine({ config: cfg, jupiterClient: { ...baseClient, async prepareEntry() { return routable(); } }, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  const soloResult = await solo.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 's1', observedAt: 1_000_000 });
  assert.equal(soloResult.status, 'filled');
  solo.stopAutomation();

  // Each deferred (RATE_LIMITED) attempt consumes one prepareEntry call; the attempt that
  // finally succeeds consumes two (initial assessment, then revalidation before the fill).
  const queue = [{ ok: false, outcome: 'RATE_LIMITED' }, { ok: false, outcome: 'RATE_LIMITED' }, { ok: false, outcome: 'RATE_LIMITED' }, routable(), routable()];
  const strong = new RefinedPaperEngine({ config: cfg, jupiterClient: { ...baseClient, async prepareEntry() { return queue.shift(); } }, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  await strong.handleWalletSignal({ mint: MINT_2, wallet: WALLET, side: 'buy', signature: 'a', observedAt: 1_000_000 });
  await strong.handleWalletSignal({ mint: MINT_2, wallet: WALLET_2, side: 'buy', signature: 'b', observedAt: 1_000_000 });
  await strong.handleWalletSignal({ mint: MINT_2, wallet: WALLET_3, side: 'buy', signature: 'c', observedAt: 1_000_000 });
  const finalResult = await strong.handleWalletSignal({ mint: MINT_2, wallet: WALLET_4, side: 'buy', signature: 'd', observedAt: 1_000_000 });
  assert.equal(finalResult.status, 'filled');
  assert.equal(strong.state.intents.at(-1).classification, 'STRONG');
  assert.equal(strong.state.positions[0].sourceWallets.length, 4);
  strong.stopAutomation();
});

test('FlowDeck Lite: a structurally sound trade is not vetoed by the near-zero-evidence Bayesian expectancy prior', async () => {
  const negative = { ...routable(), roundTripLossLamports: '50000000', roundTripLossBps: 5000 };
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return negative; }, status() { return {}; }
  };
  const engine = new RefinedPaperEngine({
    config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {}
  });
  const result = await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'lite-1', observedAt: 1_000_000 });
  assert.equal(result.status, 'filled');
  assert.ok(Number(engine.state.intents.at(-1).mathematics.brain.expectedNetSol) < 0, 'expectedNetSol should be genuinely negative in this fixture');
  engine.stopAutomation();
});

test('FlowDeck Lite: a qualifying GMGN discovery tier reaches the same fill pipeline as a wallet signal', async () => {
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return routable(); }, status() { return {}; }
  };
  const engine = new RefinedPaperEngine({
    config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {}
  });
  engine.setAutoRun(true);
  const result = engine.setMarket({ mint: MINT, symbol: 'DISC', marketCapUsd: 30000, volumeUsd: 5000, feesSol: 0.5, hasSocial: true, observedAt: 1_000_000 });
  assert.equal(result.status, 'updated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.state.positions.length, 1);
  assert.equal(engine.state.positions[0].discoverySource, 'BRAND_NEW');
  assert.equal(engine.state.candidates.at(-1).sourceWallets.length, 0);
  engine.stopAutomation();
});

test('FlowDeck Lite: a market update that matches no discovery tier never creates a candidate', async () => {
  const engine = new RefinedPaperEngine({ config: config(), jupiterClient: { async quoteSolUsd() { return { ok: false }; } }, clock: () => 1_000_000, waitImpl: async () => {} });
  engine.setAutoRun(true);
  engine.setMarket({ mint: MINT, marketCapUsd: 500, volumeUsd: 10, feesSol: 0.001, observedAt: 1_000_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.state.candidates.length, 0);
  engine.stopAutomation();
});

test('FlowDeck Lite: the 30s opportunity window is signal age, not token age', async () => {
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return routable(); }, status() { return {}; }
  };
  const fresh = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  assert.equal((await fresh.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'w30', observedAt: 970_001 })).status, 'filled');
  fresh.stopAutomation();
  const stale = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  assert.equal((await stale.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'w31', observedAt: 969_999 })).status, 'expired');
  stale.stopAutomation();
});

test('FlowDeck Lite: GMGN Soon Migrated and Migrated tiers reach the fill pipeline the same way Brand New does', async () => {
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return routable(); }, status() { return {}; }
  };
  const soon = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  soon.setAutoRun(true);
  // ageMinutes here is a discovery-tier business rule (SOON_MIGRATED admits tokens up to 600
  // minutes old); it is unrelated to the opportunity/signal freshness gate, which always keys
  // off "now" regardless of how old the token itself is (see the token-age-independence test).
  soon.setMarket({ mint: MINT, symbol: 'SOON', marketCapUsd: 25000, feesSol: 3, ageMinutes: 500, observedAt: 1_000_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(soon.state.positions[0]?.discoverySource, 'SOON_MIGRATED');
  soon.stopAutomation();

  const migrated = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  migrated.setAutoRun(true);
  migrated.setMarket({ mint: MINT_2, symbol: 'MIG', marketCapUsd: 40000, feesSol: 4, hasSocial: true, observedAt: 1_000_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(migrated.state.positions[0]?.discoverySource, 'MIGRATED');
  migrated.stopAutomation();
});

test('FlowDeck Lite: X evidence is neutral when absent and only pushes an otherwise-thin candidate to NORMAL confidence, never AVOID', async () => {
  // Negative expectedNetSol keeps the classify() NORMAL branch from firing on brain math alone,
  // isolating the social bonus as the only thing that can move EXPERIMENTAL -> NORMAL here.
  const negative = { ...routable(), roundTripLossLamports: '50000000', roundTripLossBps: 5000 };
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return negative; }, status() { return {}; }
  };
  const noSocial = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  let result = await noSocial.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'x-neutral', observedAt: 1_000_000 });
  assert.equal(result.status, 'filled');
  assert.equal(noSocial.state.intents.at(-1).classification, 'EXPERIMENTAL');
  noSocial.stopAutomation();

  const withSocial = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research()), clock: () => 1_000_000, waitImpl: async () => {} });
  withSocial.setMarket({ mint: MINT, hasSocial: true, socialViews: 500, observedAt: 1_000_000 });
  result = await withSocial.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'x-positive', observedAt: 1_000_000 });
  assert.equal(result.status, 'filled');
  assert.equal(withSocial.state.intents.at(-1).classification, 'NORMAL');
  withSocial.stopAutomation();
});

test('GMGN hard rejects blacklist entries while incomplete research is paper-only experimental', async () => {
  const client = {
    async quoteSolUsd() { return { ok: true, price: '1400', observedAt: 1_000_000, source: 'MOCK' }; },
    async prepareEntry() { return routable(); }, status() { return {}; }
  };
  let engine = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(research({ mint: MINT, symbol: 'USWR', name: 'USWR', source: 'GMGN' })), clock: () => 1_000_000, waitImpl: async () => {} });
  let result = await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'blocked', observedAt: 1_000_000 });
  assert.equal(result.status, 'no-fill');
  assert.match(result.reason, /BLACKLISTED_IDENTITY/);

  const incomplete = research(undefined, true);
  let broadcasts = 0;
  engine = new RefinedPaperEngine({ config: config(), jupiterClient: client, researchProvider: researchProvider(incomplete), liveAdapter: { async execute() { broadcasts += 1; } }, clock: () => 1_000_000, waitImpl: async () => {} });
  result = await engine.handleWalletSignal({ mint: MINT, wallet: WALLET, side: 'buy', signature: 'experimental', observedAt: 1_000_000 });
  assert.equal(result.status, 'filled');
  assert.equal(engine.state.intents[0].classification, 'EXPERIMENTAL');
  assert.equal(engine.state.intents[0].securityResult.result, 'NEEDS_DEEPER_RESEARCH');
  assert.equal(engine.checkLiveReadiness().status, 'blocked');
  engine.state.mode = 'BOT_LIVE';
  result = await engine.handleWalletSignal({ mint: MINT_2, wallet: WALLET_2, side: 'buy', signature: 'live-incomplete', observedAt: 1_000_000 });
  assert.equal(result.status, 'no-fill');
  assert.equal(engine.state.positions.length, 1);
  assert.equal(broadcasts, 0);
});

test('token identity prefers GMGN, then on-chain metadata, then the explicit fallback', () => {
  assert.deepEqual(tokenIdentity({ mint: MINT, gmgnInfo: { name: 'Jupiter', symbol: 'JUP' }, onChain: { name: 'Other', symbol: 'OTHER' } }), { mint: MINT, name: 'Jupiter', symbol: 'JUP', source: 'GMGN' });
  assert.deepEqual(tokenIdentity({ mint: MINT, onChain: { name: 'On-chain Token', symbol: 'CHAIN' } }), { mint: MINT, name: 'On-chain Token', symbol: 'CHAIN', source: 'ON_CHAIN' });
  assert.deepEqual(tokenIdentity({ mint: MINT }), { mint: MINT, name: 'Unknown token', symbol: 'Unknown token', source: 'FALLBACK' });
});

test('GMGN provider validates once, caches summaries and performs only read-only commands', async () => {
  let now = 1_000_000;
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push([...args]); now += 1;
    if (args[0] === 'config') return { stdout: '{}' };
    if (args[1] === 'info') return { stdout: JSON.stringify({ data: { name: 'Test Token', symbol: 'TEST', liquidity: 50_000 } }) };
    if (args[1] === 'security') return { stdout: JSON.stringify({ data: { renounced_mint: true, renounced_freeze_account: true, is_wash_trading: false, rug_ratio: 0.1, top_10_holder_rate: 0.2 } }) };
    if (args[1] === 'pool') return { stdout: JSON.stringify({ data: { liquidity: 50_000, exchange: 'mock-dex' } }) };
    return { stdout: JSON.stringify({ data: [{ time: 1, open: 1, close: 1.1, high: 1.2, low: 0.9, volume: 100 }] }) };
  };
  const provider = new GmgnResearchProvider({ config: config(), clock: () => now, waitImpl: async (milliseconds) => { now += milliseconds; }, commandRunner: runner });
  const first = await provider.inspectMint(MINT);
  const second = await provider.inspectMint(MINT);
  assert.equal(first.filter.result, 'PASSED_FIRST_FILTER');
  assert.equal(second.cached, true);
  assert.equal(calls.filter((args) => args[0] === 'config').length, 1);
  assert.deepEqual(calls.filter((args) => args[0] !== 'config').map((args) => args.slice(0, 2)).sort(), [['market', 'kline'], ['token', 'info'], ['token', 'pool'], ['token', 'security']]);
});
