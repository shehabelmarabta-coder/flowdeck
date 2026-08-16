'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig } = require('../src/default-config');
const { startServer } = require('../src/server');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '11111111111111111111111111111111';

function route(inputAmountAtomic, outputAmountAtomic) {
  return { ok: true, inputAmountAtomic: String(inputAmountAtomic), outAmountAtomic: String(outputAmountAtomic), minimumOutputAtomic: '', receivedAt: Date.now(), requestId: 'mock', router: 'mock', routePlan: [], transactionPresent: false, feeAccountingComplete: false, signatureFeeLamports: '0', prioritizationFeeLamports: '0' };
}

const jupiterClient = {
  // Priced so the default $14 target sizes to exactly 10,000,000 lamports (14 / 1400 * 1e9).
  async quoteSolUsd() { return { ok: true, price: '1400', observedAt: Date.now(), source: 'MOCK_SOL_USD' }; },
  async prepareEntry({ inputLamports }) {
    const entry = route(inputLamports, '1000000');
    // Reverse leg calibrated so a freshly-opened position clears the Fix 2 opening-basis
    // assertion (<=1.5%) at this fixture's fixed lamport fee floor.
    const reverse = route('1000000', '10300000');
    return { ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals: 6, conservativeTokenAtomic: '1000000', quotedTokenAtomic: '1000000', roundTripLossLamports: '500000', roundTripLossBps: 500 };
  },
  async quoteReverse({ tokenAmountAtomic }) { return route(tokenAmountAtomic, '10300000'); },
  status() { return { available: true, executionEnabled: false }; }
};

test('local final API starts AUTO, fills an enabled-wallet paper signal, locks credentials, and rejects web origins', async (t) => {
  const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-server-test-'));
  t.after(() => fs.rmSync(auditDirectory, { recursive: true, force: true }));
  const config = normalizeConfig({
    bind: '127.0.0.1',
    paper: { latencyMs: 0, maxPriceAgeMs: 10_000 },
    priceFallback: { enabled: false },
    bot: { refined: { executionDelayDefaultMs: 250 } },
    wallets: [{ address: WALLET, enabled: true, weight: 1 }]
  });
  const monitor = { start() {}, stop() {} };
  const priceProvider = { start() {}, stop() {} };
  const app = await startServer({ config, store: null, monitor, priceProvider, auditDirectory, jupiterClient, simulator: null, port: 0 });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  let response = await fetch(`${app.url}/api/market`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mint: MINT, priceUsd: 0.001, source: 'test' })
  });
  assert.equal(response.status, 200);

  const resumeStartedAt = performance.now();
  response = await fetch(`${app.url}/api/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-auto', enabled: true })
  });
  assert.equal((await response.json()).status, 'updated');
  assert.ok(performance.now() - resumeStartedAt < 500);

  response = await fetch(`${app.url}/api/signal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'solana-rpc', wallet: WALLET, mint: MINT, side: 'buy', signature: 'server-signal' })
  });
  assert.equal((await response.json()).status, 'filled');

  response = await fetch(`${app.url}/api/snapshot?mint=${MINT}`);
  const snapshot = await response.json();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.schemaVersion, 'flowdeck-final-state-v1');

  response = await fetch(`${app.url}/api/audit/events.csv`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^schema_version,session_id,event_id,/);

  response = await fetch(`${app.url}/api/audit/quotes.csv`);
  assert.equal(response.status, 404);

  response = await fetch(`${app.url}/api/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /never accepts a private key/i);

  response = await fetch(`${app.url}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set-mode', mode: 'BOT_LIVE' }) });
  assert.equal((await response.json()).status, 'blocked');

  response = await fetch(`${app.url}/api/health`, { headers: { origin: 'https://malicious.example' } });
  assert.equal(response.status, 403);
});
