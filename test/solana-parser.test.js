'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWalletSwaps } = require('../src/solana-parser');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';

function transaction(pre, post, signature = '5fakeSignature') {
  const item = (amount) => ({ mint: MINT, owner: WALLET, uiTokenAmount: { uiAmountString: String(amount) } });
  return {
    blockTime: 1_700_000_000,
    transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: WALLET }] } },
    meta: {
      preTokenBalances: [item(pre)],
      postTokenBalances: [item(post)],
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      logMessages: ['Program log: Instruction: Swap']
    }
  };
}

test('parses a token balance increase as a wallet buy', () => {
  const [event] = parseWalletSwaps(transaction(0, 125), WALLET);
  assert.equal(event.side, 'buy');
  assert.equal(event.tokenDelta, 125);
  assert.equal(event.fraction, null);
  assert.equal(event.mint, MINT);
});

test('parses a token balance decrease and mirrors its exit fraction', () => {
  const [event] = parseWalletSwaps(transaction(100, 25), WALLET);
  assert.equal(event.side, 'sell');
  assert.equal(event.tokenDelta, -75);
  assert.equal(event.fraction, 0.75);
});

test('ignores balance changes owned by a different wallet', () => {
  const tx = transaction(0, 125);
  tx.meta.preTokenBalances[0].owner = 'Dc9jiLSNN8qwEciwd55HmZhroswZ4XvcvKeRXHWCnwbP';
  tx.meta.postTokenBalances[0].owner = 'Dc9jiLSNN8qwEciwd55HmZhroswZ4XvcvKeRXHWCnwbP';
  assert.deepEqual(parseWalletSwaps(tx, WALLET), []);
});

test('does not mistake an ordinary token transfer for a trade', () => {
  const tx = transaction(100, 25);
  tx.meta.logMessages = ['Program log: Instruction: TransferChecked'];
  tx.meta.preBalances = [1_000_000_000];
  tx.meta.postBalances = [999_995_000];
  assert.deepEqual(parseWalletSwaps(tx, WALLET), []);
});
