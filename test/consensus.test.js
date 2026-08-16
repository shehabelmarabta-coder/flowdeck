'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RollingConsensus } = require('../src/consensus');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLETS = [
  '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b',
  '2PLWjaYV7KiKMmUXkC2d4qxqTXjSDMm4EDXqCXw7MRr1',
  '9PWZLzVSLNxCoYCKLKqpprusX5ygMVqo6a6L5Ro6JQYL'
];

test('suppresses duplicate signatures and duplicate wallet votes', () => {
  let now = 100_000;
  const consensus = new RollingConsensus({ wallets: WALLETS.map((address) => ({ address, weight: 1, enabled: true })), clock: () => now });
  assert.equal(consensus.ingest({ mint: MINT, wallet: WALLETS[0], signature: 'sig-1', observedAt: now }).status, 'accepted');
  assert.equal(consensus.ingest({ mint: MINT, wallet: WALLETS[1], signature: 'sig-1', observedAt: now }).reason, 'duplicate-signature');
  assert.equal(consensus.ingest({ mint: MINT, wallet: WALLETS[0], signature: 'sig-2', observedAt: now }).reason, 'wallet-already-voted-in-window');
  assert.equal(consensus.snapshot(MINT).normal.walletCount, 1);
});

test('calculates rolling weighted consensus and expires old votes', () => {
  let now = 100_000;
  const consensus = new RollingConsensus({ wallets: [
    { address: WALLETS[0], weight: 2, enabled: true }, { address: WALLETS[1], weight: 1, enabled: true }, { address: WALLETS[2], weight: 1, enabled: true }
  ], normalWindowMs: 60_000, strongWindowMs: 45_000, clock: () => now });
  consensus.ingest({ mint: MINT, wallet: WALLETS[0], signature: 'a', observedAt: now });
  consensus.ingest({ mint: MINT, wallet: WALLETS[1], signature: 'b', observedAt: now });
  assert.equal(consensus.snapshot(MINT).normal.weightedConsensusPct, 75);
  now += 50_000;
  assert.equal(consensus.snapshot(MINT).strong.walletCount, 0);
  assert.equal(consensus.snapshot(MINT).normal.walletCount, 2);
  now += 11_000;
  assert.equal(consensus.snapshot(MINT).normal.walletCount, 0);
});
