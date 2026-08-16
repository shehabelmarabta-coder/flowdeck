'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../src/default-config');
const { SolanaWalletMonitor, looksLikeSwapLogs } = require('../src/wallet-monitor');

const WALLET = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';
const WALLET_2 = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';

function response(result) {
  return { ok: true, json: async () => ({ result }) };
}

test('reconnect catch-up processes missed signatures oldest first', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, label: 'A', enabled: true }] });
  const statuses = [];
  const monitor = new SolanaWalletMonitor({
    config,
    onSignal() {},
    onStatus: (status) => statuses.push(status),
    fetchImpl: async () => response([
      { signature: 'newest', err: null },
      { signature: 'middle', err: null },
      { signature: 'previous', err: null }
    ])
  });
  monitor.latestSignatureByWallet.set(WALLET, 'previous');
  const processed = [];
  monitor._processSignature = async (signature) => processed.push(signature);
  await monitor._baselineOrCatchup(config.wallets[0]);
  assert.deepEqual(processed, ['middle', 'newest']);
  assert.equal(monitor.latestSignatureByWallet.get(WALLET), 'newest');
  assert.equal(statuses.at(-1).rpcCatchupCount, 2);
});

test('first connection establishes a baseline without replaying old trades', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({
    config,
    onSignal() {},
    fetchImpl: async () => response([{ signature: 'baseline', err: null }])
  });
  let processed = 0;
  monitor._processSignature = async () => { processed += 1; };
  await monitor._baselineOrCatchup(config.wallets[0]);
  assert.equal(processed, 0);
  assert.equal(monitor.latestSignatureByWallet.get(WALLET), 'baseline');
});

test('creates exactly one mentions logsSubscribe request per enabled wallet', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }, { address: WALLET_2, enabled: true }] });
  const sent = [];
  const monitor = new SolanaWalletMonitor({ config, onSignal() {}, fetchImpl: async () => response([]) });
  monitor.socket = { send: (value) => sent.push(JSON.parse(value)) };
  monitor._subscribe();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((item) => item.method), ['logsSubscribe', 'logsSubscribe']);
  assert.deepEqual(sent.map((item) => item.params[0].mentions), [[WALLET], [WALLET_2]]);
  assert.ok(sent.every((item) => item.params[1].commitment === 'processed'));
});

test('suppresses duplicate signature plus wallet notifications', () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const evidence = [];
  const monitor = new SolanaWalletMonitor({ config, onSignal() {}, onEvidence: (value) => evidence.push(value) });
  monitor.subscriptionWallets.set(7, config.wallets[0]);
  let queued = 0;
  monitor._enqueue = () => { queued += 1; return Promise.resolve(); };
  const notification = JSON.stringify({ method: 'logsNotification', params: { subscription: 7, result: { context: { slot: 99 }, value: { signature: 'same', err: null, logs: [] } } } });
  monitor._onMessage(notification);
  monitor._onMessage(notification);
  assert.equal(queued, 1);
  assert.equal(evidence.filter((item) => item.type === 'RPC_NOTIFICATION').length, 1);
  assert.equal(monitor.snapshotHealth().duplicateSignaturesIgnored, 1);
});

test('reconciles processed notifications to confirmed or failed status', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const evidence = [];
  const monitor = new SolanaWalletMonitor({ config, onSignal() {}, onEvidence: (value) => evidence.push(value) });
  monitor._rpc = async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] });
  assert.equal(await monitor._confirmation('confirmed-signature', config.wallets[0], Date.now()), 'confirmed');
  monitor._rpc = async () => ({ value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] });
  assert.equal(await monitor._confirmation('failed-signature', config.wallets[0], Date.now()), 'failed');
  assert.deepEqual(evidence.map((item) => item.type), ['PROCESSED_LATER_CONFIRMED', 'PROCESSED_LATER_FAILED']);
});

test('prefilters definite non-swap logs before spending a transaction RPC request', () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({ config, onSignal() {} });
  monitor.subscriptionWallets.set(7, config.wallets[0]);
  let queued = 0; monitor._enqueue = () => { queued += 1; return Promise.resolve(); };
  monitor._onMessage(JSON.stringify({ method: 'logsNotification', params: { subscription: 7, result: { context: { slot: 99 }, value: { signature: 'transfer-only', err: null, logs: ['Program log: Instruction: Transfer', 'Program consumed 1000 units'] } } } }));
  assert.equal(queued, 0); assert.equal(monitor.snapshotHealth().prefilteredNonSwap, 1);
  assert.equal(looksLikeSwapLogs(['Program log: Instruction: Swap']), true);
  assert.equal(looksLikeSwapLogs(['Program log: Instruction: Transfer']), false);
});

test('HTTP 429 honors Retry-After and retries instead of becoming an immediate fetch failure', async () => {
  let now = 1000; let calls = 0; const waits = [];
  const config = normalizeConfig({ rpc: { maxAttempts: 3, requestsPerSecond: 100, fetchConcurrency: 1 }, wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({
    config, onSignal() {}, clock: () => now, random: () => 0,
    waitImpl: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0.01' }, json: async () => ({}) };
      return response({ value: 'ok' });
    }
  });
  assert.deepEqual(await monitor._rpc('testMethod', []), { value: 'ok' });
  assert.equal(calls, 2); assert.equal(monitor.snapshotHealth().rpcRateLimited, 1); assert.ok(waits.some((value) => value >= 10));
});

test('bounded work queue lets a live notification preempt low-priority catch-up', async () => {
  const config = normalizeConfig({ rpc: { maxQueueSize: 10, fetchConcurrency: 1 }, wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({ config, onSignal() {} });
  monitor.activeFetches = 1;
  for (let index = 0; index < 10; index += 1) void monitor._enqueue(async () => index, { priority: 'backfill' });
  void monitor._enqueue(async () => 'live', { priority: 'live' });
  assert.equal(monitor.queue.length, 10); assert.equal(monitor.queue[0].priority, 'live'); assert.equal(monitor.snapshotHealth().droppedBackfill, 1);
});

test('a large historical backfill cannot grow the queue behind a fresh live notification', async () => {
  const config = normalizeConfig({ rpc: { maxQueueSize: 50, fetchConcurrency: 1 }, wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({ config, onSignal() {} });
  monitor.activeFetches = 1;
  for (let index = 0; index < 400; index += 1) void monitor._enqueue(async () => `backfill-${index}`, { priority: 'backfill' });
  assert.equal(monitor.queue.length, 50, 'the queue must stay bounded to maxQueueSize regardless of how much historical work arrives');
  void monitor._enqueue(async () => 'live', { priority: 'live' });
  assert.equal(monitor.queue.length, 50, 'admitting the live item must not grow the queue past its bound');
  assert.equal(monitor.queue[0].priority, 'live', 'the live item must be dispatched ahead of every queued historical item');
  assert.ok(monitor.snapshotHealth().droppedBackfill >= 350, 'excess historical work is dropped, not left to accumulate behind live traffic');
});

test('backfilled signatures never schedule confirmation polling, which is where hours of live delay came from', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({ config, onSignal: async () => {} });
  let scheduled = 0;
  monitor._scheduleConfirmation = () => { scheduled += 1; };
  monitor._transaction = async () => ({
    meta: { preTokenBalances: [], postTokenBalances: [{ owner: WALLET, mint: 'Mint111111111111111111111111111111111111q', uiTokenAmount: { amount: '1000', decimals: 0 } }], preBalances: [1_000_000_000], postBalances: [900_000_000], logMessages: ['Program log: Instruction: Swap'] },
    transaction: { signatures: ['sig-backfill'], message: { accountKeys: [WALLET] } }, blockTime: Math.floor(monitor.clock() / 1000)
  });
  await monitor._processSignature('sig-backfill', config.wallets[0], { notificationAt: monitor.clock(), backfilled: true, commitment: 'confirmed' });
  assert.equal(scheduled, 0, 'a backfilled signature already carries a known confirmation status and must not spend RPC capacity polling for it');

  monitor._transaction = async () => ({
    meta: { preTokenBalances: [], postTokenBalances: [{ owner: WALLET, mint: 'Mint111111111111111111111111111111111111q', uiTokenAmount: { amount: '1000', decimals: 0 } }], preBalances: [1_000_000_000], postBalances: [900_000_000], logMessages: ['Program log: Instruction: Swap'] },
    transaction: { signatures: ['sig-live'], message: { accountKeys: [WALLET] } }, blockTime: Math.floor(monitor.clock() / 1000)
  });
  await monitor._processSignature('sig-live', config.wallets[0], { notificationAt: monitor.clock(), backfilled: false, commitment: 'processed' });
  assert.equal(scheduled, 1, 'a genuinely live signature still gets confirmation reconciliation');
});

test('confirmation reconciliation is routed through the bounded/prioritized queue, not a direct RPC call', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  const monitor = new SolanaWalletMonitor({ config, onSignal() {} });
  const priorities = [];
  monitor._enqueue = (task, { priority } = {}) => { priorities.push(priority); return Promise.resolve(task()); };
  monitor._rpc = async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] });
  await monitor._confirmation('sig', config.wallets[0], monitor.clock());
  assert.deepEqual(priorities, ['backfill'], 'confirmation polling must queue behind live work, never bypass the priority scheduler');
});

test('a live notification already older than the freshness budget is dropped before spending an RPC fetch', async () => {
  const config = normalizeConfig({ wallets: [{ address: WALLET, enabled: true }] });
  let fetchCalled = false;
  const monitor = new SolanaWalletMonitor({ config, onSignal: async () => {}, fetchImpl: async () => { fetchCalled = true; return response(null); } });
  const evidence = [];
  monitor.onEvidence = (item) => evidence.push(item);
  const notificationAt = monitor.clock() - 11_000;
  await monitor._processSignature('sig-expired', config.wallets[0], { notificationAt, backfilled: false, commitment: 'processed' });
  assert.equal(fetchCalled, false, 'processing must not spend an RPC round trip on a live item that is already unsalvageably stale');
  assert.equal(monitor.snapshotHealth().droppedLive, 1);
  assert.equal(evidence.at(-1).type, 'LIVE_SIGNAL_EXPIRED_BEFORE_FETCH');
});
