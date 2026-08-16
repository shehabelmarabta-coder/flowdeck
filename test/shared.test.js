'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../extension/shared');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

test('decodes GMGN compact small-number notation', () => {
  assert.equal(shared.decodeCompactSmallNumber('$0.0₃717'), '$0.000717');
  assert.equal(shared.parseCompactNumber('$0.0₃717'), 0.000717);
});

test('parses abbreviated market cap and supply values', () => {
  assert.equal(shared.parseCompactNumber('$716.86K'), 716_860);
  assert.equal(shared.parseCompactNumber('999.9M'), 999_900_000);
});

test('extracts a Solana mint from a GMGN route', () => {
  assert.equal(shared.extractMintFromUrl(`https://gmgn.ai/sol/token/${MINT}`), MINT);
});
