'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWalletRoster } = require('../scripts/build-wallets');

const SOL = 'So11111111111111111111111111111111111111112';
const MINTS = ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6mXjBAipCHBSSUB'];
const WALLETS = ['3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b', '2PLWjaYV7KiKMmUXkC2d4qxqTXjSDMm4EDXqCXw7MRr1'];

function rows() {
  const result = [];
  WALLETS.forEach((wallet, walletIndex) => MINTS.forEach((mint, tokenIndex) => {
    const minute = walletIndex * 3 + tokenIndex;
    result.push({ trader_id: wallet, tx_id: `b${walletIndex}${tokenIndex}`, block_time: `2026-01-01 00:${String(minute).padStart(2, '0')}:00.000 UTC`, amount_usd: 100, token_bought_mint_address: mint, token_bought_amount: 1000, token_sold_mint_address: SOL, token_sold_amount: 1 });
    result.push({ trader_id: wallet, tx_id: `s${walletIndex}${tokenIndex}`, block_time: `2026-01-01 00:${String(minute + 10).padStart(2, '0')}:00.000 UTC`, amount_usd: walletIndex ? 110 : 140, token_bought_mint_address: SOL, token_bought_amount: 1, token_sold_mint_address: mint, token_sold_amount: 1000 });
  }));
  return result;
}

test('wallet ranking is deterministic and favors stronger modeled performance', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-wallets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'trades_aaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify(rows()));
  const first = buildWalletRoster({ cacheDirectory: directory, outputPath: path.join(directory, 'one.json') });
  const second = buildWalletRoster({ cacheDirectory: directory, outputPath: path.join(directory, 'two.json') });
  assert.deepEqual(first.wallets, second.wallets);
  assert.equal(first.wallets[0].address, WALLETS[0]);
  assert.equal(first.wallets.every((wallet) => wallet.finalWeight >= 0.5 && wallet.finalWeight <= 2), true);
});
