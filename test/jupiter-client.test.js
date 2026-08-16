'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decimalToAtomic, atomicToDecimalString, SOL_MINT } = require('../src/atomic');
const { normalizeConfig } = require('../src/default-config');
const { JupiterOrderClient, PRICE_QUALITY, TokenBucket } = require('../src/jupiter-client');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const TAKER = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('SOL and token decimal strings round-trip through exact atomic units', () => {
  assert.equal(decimalToAtomic('0.01', 9), 10_000_000n);
  assert.equal(atomicToDecimalString(10_000_000n, 9), '0.01');
  assert.equal(decimalToAtomic('123456789.123456', 6), 123456789123456n);
  assert.equal(atomicToDecimalString(123456789123456n, 6), '123456789.123456');
});

test('entry and reverse order requests preserve exact atomic amounts', async () => {
  const config = normalizeConfig({ jupiter: { cacheMs: 0, paperTakerAddress: '' } });
  const calls = [];
  const client = new JupiterOrderClient({
    config,
    decimalsResolver: async () => 6,
    fetchImpl: async (url) => {
      const parsed = new URL(url); calls.push(parsed);
      return response({ outAmount: calls.length === 1 ? '123456789123' : '9900000', requestId: `r${calls.length}`, router: 'iris', mode: 'ExactIn' });
    }
  });
  const assessment = await client.prepareEntry({ outputMint: MINT, inputLamports: '10000000' });
  assert.equal(assessment.ok, true);
  assert.equal(calls[0].searchParams.get('amount'), '10000000');
  assert.equal(calls[0].searchParams.get('inputMint'), SOL_MINT);
  // Reverse leg is sized off the modelled fill (realistic), not the raw/conservative entry
  // amount, so a real round-trip risk estimate reflects what would actually be received.
  assert.equal(assessment.conservativeTokenAtomic, '123456789123');
  assert.equal(calls[1].searchParams.get('amount'), assessment.modelledTokenAtomic);
  assert.equal(calls[1].searchParams.get('amount'), '122962961966');
  assert.equal(calls[1].searchParams.get('inputMint'), MINT);
  assert.equal(assessment.roundTripLossLamports, '100000');
});

test('quote-only and unsigned buildable-order labels remain distinct', async () => {
  const config = normalizeConfig({ jupiter: { cacheMs: 0 } });
  const client = new JupiterOrderClient({ config, fetchImpl: async () => response({ outAmount: '42', transaction: 'unsigned-base64', requestId: 'r' }) });
  const quoteOnly = await client.order({ inputMint: SOL_MINT, outputMint: MINT, inputAmountAtomic: '1' });
  const buildable = await client.order({ inputMint: SOL_MINT, outputMint: MINT, inputAmountAtomic: '2', taker: TAKER });
  assert.equal(quoteOnly.priceQuality, PRICE_QUALITY.JUPITER_ROUTE_QUOTE);
  assert.equal(quoteOnly.transactionPresent, false);
  assert.equal(buildable.priceQuality, PRICE_QUALITY.JUPITER_BUILDABLE_ORDER);
  assert.equal(buildable.transactionPresent, true);
  assert.notEqual(buildable.priceQuality, PRICE_QUALITY.LIVE_FILL);
});

test('quote timeout returns no route and never falls through to an execution request', async () => {
  const config = normalizeConfig({ jupiter: { timeoutMs: 250 } });
  const urls = [];
  const client = new JupiterOrderClient({
    config,
    fetchImpl: async (url) => { urls.push(String(url)); const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
  });
  const result = await client.prepareEntry({ outputMint: MINT, inputLamports: '10000000' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'QUOTE_EXPIRED');
  assert.equal(urls.length, config.jupiter.maxAttempts);
  assert.ok(urls[0].includes('/order?'));
  assert.ok(urls.every((url) => !url.includes('/execute')));
});

test('paper Jupiter client source contains no execute endpoint', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'jupiter-client.js'), 'utf8');
  assert.doesNotMatch(source, /\/execute(?:\?|["'`/])/i);
});

test('token bucket serializes concurrent admission instead of releasing a request burst', async () => {
  let now = 0;
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, clock: () => now, waitImpl: async (milliseconds) => { now += milliseconds; } });
  const waits = await Promise.all([bucket.take(), bucket.take(), bucket.take()]);
  assert.deepEqual(waits, [0, 1000, 1000]);
  assert.equal(now, 2000);
});
