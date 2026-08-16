'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBrain, correlatedClusters } = require('../src/brain');
const { normalizeConfig } = require('../src/default-config');

const W1 = '9SeRj4LjgENeKQujfxRNkGbXYPM3X2vr9C37Jg9AARfg';
const W2 = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';
const M1 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const M2 = '5SMsXTuALkMguqL1snrkKKwWKSRtBo2x51ybA7jnpump';

function assessment() {
  return { entry: { ok: true }, reverse: { ok: true }, roundTripLossLamports: '100000', roundTripLossBps: 100 };
}

test('two wins from two unique mints remain insufficient and strongly shrunk', () => {
  const config = normalizeConfig();
  const closedPositions = [M1, M2].map((mint, index) => ({
    mint, sourceWallets: [{ address: W1 }], tp1Complete: true, exitReason: 'final-take-profit',
    initialAmountSol: 0.01, realizedPnlSol: 0.005, exitAt: index + 1
  }));
  const brain = evaluateBrain({
    candidate: { sourceWallets: [{ address: W1 }], lastSignalAt: 1000, riskFlags: {}, security: {} },
    assessment: assessment(), closedPositions, config, decisionAt: 1000
  });
  assert.equal(brain.evidenceGrade, 'INSUFFICIENT');
  assert.equal(brain.walletUniqueMintSample, 2);
  assert.ok(brain.tp1Posterior.mean < 0.6);
  assert.ok(brain.tp1Posterior.credibleInterval[1] - brain.tp1Posterior.credibleInterval[0] > 0.2);
  assert.equal(brain.tp1Posterior.priorEquivalentSampleSize, 20);
});

test('repeated entries in one mint count as one historical trial', () => {
  const config = normalizeConfig();
  const repeated = [1, 2, 3].map((exitAt) => ({ mint: M1, sourceWallets: [{ address: W1 }], tp1Complete: true, initialAmountSol: 0.01, realizedPnlSol: 0.001, exitAt }));
  const brain = evaluateBrain({ candidate: { sourceWallets: [{ address: W1 }], lastSignalAt: 10, riskFlags: {}, security: {} }, assessment: assessment(), closedPositions: repeated, config, decisionAt: 10 });
  assert.equal(brain.walletUniqueMintSample, 1);
  assert.equal(brain.tp1Posterior.trials, 1);
});

test('correlated wallets collapse to one independent cluster', () => {
  const pair = [W1, W2].sort().join('|');
  const clusters = correlatedClusters([{ address: W1 }, { address: W2 }], { [pair]: 2 }, 2);
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].members), new Set([W1, W2]));
});
