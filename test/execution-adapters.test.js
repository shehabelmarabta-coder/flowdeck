'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GmgnExecutionAdapter } = require('../src/execution-adapters');
const { normalizeConfig } = require('../src/default-config');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';

test('live adapter matches the execution interface using only a mocked GMGN process', async () => {
  const calls = [];
  const runner = { run: async (args, options) => {
    calls.push({ args, options });
    if (args[0] === '--version') return { stdout: '9.9.9\n' };
    if (args[0] === 'portfolio' && args[1] === 'info') return { stdout: JSON.stringify({ data: { wallets: [WALLET] } }) };
    if (args[0] === 'portfolio') return { stdout: JSON.stringify({ data: [{ address: MINT, raw_amount: 1000 }] }) };
    if (args[0] === 'order' && args[1] === 'quote') return { stdout: JSON.stringify({ data: { input_amount: '1', output_amount: '2' } }) };
    if (args[0] === 'swap') return { stdout: JSON.stringify({ data: { status: 'confirmed', hash: 'tx-mock', report: { price_usd: '1.2' } } }) };
    throw new Error(`Unexpected mocked command ${args.join(' ')}`);
  } };
  const config = normalizeConfig({ gmgn: { orderPollMs: 0, orderPollAttempts: 0 } });
  const vault = { get: () => ({ apiKey: 'api', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----', fromWallet: WALLET }), status: () => ({ complete: true }) };
  const adapter = new GmgnExecutionAdapter({ config, credentialVault: vault, runner, waitImpl: async () => {} });
  assert.equal((await adapter.quote({ mint: MINT, amountSol: 0.01 })).ok, true);
  assert.equal((await adapter.buy({ mint: MINT, amountSol: 0.01 })).confirmed, true);
  assert.equal((await adapter.sellPercent({ mint: MINT, percent: 50 })).confirmed, true);
  assert.equal((await adapter.reconcilePositions()).positions[0].mint, MINT);
  assert.equal(calls.filter((call) => call.args[0] === 'swap').every((call) => call.options.trade === true && call.args.includes('--yes')), true);
});
