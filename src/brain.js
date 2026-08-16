'use strict';

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0; }

function betaPosterior({ successes, trials, priorMean, priorEquivalentSampleSize = 20, intervalZ = 1.645 }) {
  const n = Math.max(0, Number(trials || 0));
  const wins = clamp(Number(successes || 0), 0, n);
  const prior = clamp(Number(priorMean || 0.5), 0.01, 0.99);
  const ess = Math.max(2, Number(priorEquivalentSampleSize || 20));
  const alpha = prior * ess + wins;
  const beta = (1 - prior) * ess + n - wins;
  const posteriorMean = alpha / (alpha + beta);
  const variance = alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const margin = intervalZ * Math.sqrt(variance);
  return {
    model: 'BETA_BINOMIAL_V1', successes: wins, trials: n, uniqueMintTrials: n,
    priorMean: prior, priorEquivalentSampleSize: ess, alpha, beta,
    mean: posteriorMean, credibleLevel: 0.9,
    credibleInterval: [clamp(posteriorMean - margin, 0, 1), clamp(posteriorMean + margin, 0, 1)]
  };
}

function clusteredOutcomes(positions, wallet = null) {
  const byMint = new Map();
  for (const position of positions || []) {
    const wallets = position.sourceWallets?.map((item) => item.address || item) || [];
    if (wallet && !wallets.includes(wallet)) continue;
    const value = byMint.get(position.mint) || { mint: position.mint, tp1: false, final: false, netReturnPct: 0, timestamp: position.exitAt || position.entryAt || null };
    value.tp1 ||= Boolean(position.tp1Hit || position.tp1Complete || position.targetObservations?.PLUS_15?.beforeExit);
    value.final ||= ['FINAL_TARGET', 'final-take-profit'].includes(position.exitReason) || Boolean(position.targetObservations?.PLUS_50?.beforeExit);
    value.netReturnPct += Number.isFinite(Number(position.netPnlPct))
      ? Number(position.netPnlPct)
      : Number(position.initialAmountSol) > 0 ? Number(position.realizedPnlSol || 0) / Number(position.initialAmountSol) * 100 : 0;
    value.timestamp = Math.max(Number(value.timestamp || 0), Number(position.exitAt || position.entryAt || 0));
    byMint.set(position.mint, value);
  }
  return [...byMint.values()];
}

function winsorizedMean(values, lower = 0.1, upper = 0.9) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * lower)];
  const high = sorted[Math.floor((sorted.length - 1) * upper)];
  return mean(values.map((value) => clamp(value, low, high)));
}

function correlatedClusters(sourceWallets, pairCommonMints = {}, minimumCommonMints = 2) {
  const addresses = sourceWallets.map((item) => item.address || item);
  const parent = new Map(addresses.map((address) => [address, address]));
  const find = (value) => { let root = value; while (parent.get(root) !== root) root = parent.get(root); parent.set(value, root); return root; };
  const join = (a, b) => { const left = find(a); const right = find(b); if (left !== right) parent.set(right, left); };
  for (let left = 0; left < addresses.length; left += 1) for (let right = left + 1; right < addresses.length; right += 1) {
    const key = [addresses[left], addresses[right]].sort().join('|');
    if (Number(pairCommonMints[key] || 0) >= minimumCommonMints) join(addresses[left], addresses[right]);
  }
  const clusters = new Map();
  for (const address of addresses) { const root = find(address); const members = clusters.get(root) || []; members.push(address); clusters.set(root, members); }
  return [...clusters.values()].map((members, index) => ({ id: `cluster_${index + 1}`, members }));
}

function evidenceGrade(uniqueMints) {
  if (uniqueMints < 5) return 'INSUFFICIENT';
  if (uniqueMints < 10) return 'WEAK';
  if (uniqueMints < 25) return 'MODERATE';
  return 'STRONG';
}

function evaluateBrain({ candidate, assessment = null, closedPositions = [], config, decisionAt, pairCommonMints = {} }) {
  const priorEss = config.bot.brain.priorEquivalentSampleSize;
  const global = clusteredOutcomes(closedPositions);
  const primaryWallet = candidate.sourceWallets?.[0]?.address || '';
  const wallet = clusteredOutcomes(closedPositions, primaryWallet);
  const globalTp1 = betaPosterior({ successes: global.filter((item) => item.tp1).length, trials: global.length, priorMean: 0.4, priorEquivalentSampleSize: priorEss }).mean;
  const globalFinal = betaPosterior({ successes: global.filter((item) => item.final).length, trials: global.length, priorMean: 0.2, priorEquivalentSampleSize: priorEss }).mean;
  const tp1 = betaPosterior({ successes: wallet.filter((item) => item.tp1).length, trials: wallet.length, priorMean: globalTp1, priorEquivalentSampleSize: priorEss });
  const final = betaPosterior({ successes: wallet.filter((item) => item.final).length, trials: wallet.length, priorMean: globalFinal, priorEquivalentSampleSize: priorEss });
  const globalReturns = global.map((item) => item.netReturnPct);
  const walletReturns = wallet.map((item) => item.netReturnPct);
  const priorReturnPct = median(globalReturns);
  const walletRobustPct = winsorizedMean(walletReturns);
  const shrinkWeight = wallet.length / (wallet.length + priorEss);
  const shrunkReturnPct = shrinkWeight * walletRobustPct + (1 - shrinkWeight) * priorReturnPct;
  const roundTripLossLamports = Number(assessment?.conservativeRoundTripLossLamports ?? assessment?.roundTripLossLamports ?? 0);
  const amountSol = /^\d+$/.test(String(candidate.plannedInputLamports || ''))
    ? Number(candidate.plannedInputLamports) / 1e9
    : Number(config.bot.paperAggressive.orderSol);
  const explicitEntryAndExitCostsSol = 2 * (Number(config.paper.networkFeeSol || 0) + Number(config.paper.priorityFeeSol || 0));
  const expectedNetSol = amountSol * shrunkReturnPct / 100 - roundTripLossLamports / 1e9 - explicitEntryAndExitCostsSol;
  const clusters = correlatedClusters(candidate.sourceWallets || [], pairCommonMints, config.bot.brain.correlatedCommonMintMinimum);
  const walletWeights = new Map((candidate.sourceWallets || []).map((item) => [item.address || item, Number(item.weight || 1)]));
  const clusterAdjustedWeight = clusters.reduce((total, cluster) => {
    const weights = cluster.members.map((address) => walletWeights.get(address) || 1);
    return total + (weights[0] || 0) + weights.slice(1).reduce((sum, weight) => sum + weight * 0.25, 0);
  }, 0);
  const positiveReasons = [];
  const negativeReasons = [];
  if (assessment?.entry?.ok) positiveReasons.push('AMOUNT_SPECIFIC_ENTRY_ROUTE'); else negativeReasons.push('NO_ENTRY_ROUTE');
  if (assessment?.reverse?.ok) positiveReasons.push('IMMEDIATE_REVERSE_ROUTE'); else negativeReasons.push('NO_SELL_ROUTE');
  if (clusters.length > 1) positiveReasons.push('INDEPENDENT_WALLET_CLUSTERS');
  if (!wallet.length) negativeReasons.push('NO_UNIQUE_MINT_WALLET_HISTORY');
  if (assessment?.roundTripLossBps > config.bot.brain.roundTripWarningBps) negativeReasons.push('HIGH_ROUND_TRIP_COST');
  if (candidate.riskFlags?.critical === true || candidate.security?.honeypot === true) negativeReasons.push('CRITICAL_HARD_RISK');
  const signalAgeMs = Math.max(0, decisionAt - Number(candidate.lastSignalAt || decisionAt));
  let hardGate = 'PASS';
  let action = 'BUY';
  if (!assessment) { hardGate = 'WAITING_FOR_AMOUNT_SPECIFIC_QUOTE'; action = 'WAIT_FOR_QUOTE'; }
  else if (!assessment.entry?.ok) { hardGate = 'NO_ENTRY_ROUTE'; action = 'REJECT'; }
  else if (!assessment.reverse?.ok) { hardGate = 'NO_SELL_ROUTE'; action = 'REJECT'; }
  else if (signalAgeMs > config.bot.paperAggressive.priceWaitTimeoutSeconds * 1000) { hardGate = 'SIGNAL_EXPIRED'; action = 'EXPIRED'; }
  else if (negativeReasons.includes('CRITICAL_HARD_RISK')) { hardGate = 'CRITICAL_HARD_RISK'; action = 'REJECT'; }
  else if (expectedNetSol < -config.bot.brain.materialNegativeSol) { hardGate = 'MATERIALLY_NEGATIVE_EXPECTANCY'; action = 'OBSERVE'; }
  return {
    policy: 'PAPER_AGGRESSIVE_BAYES_V1', controlPolicy: 'PAPER_AGGRESSIVE_CONTROL',
    controlAction: assessment?.entry?.ok ? 'BUY' : 'WAIT_FOR_PRICE', action, hardGate,
    evidenceGrade: evidenceGrade(wallet.length), tp1Posterior: tp1, finalPosterior: final,
    expectedNetSol, expectancyModel: 'WINSORIZED_UNIQUE_MINT_SHRINKAGE_V1', shrunkReturnPct,
    roundTripLossLamports: String(assessment?.conservativeRoundTripLossLamports ?? assessment?.roundTripLossLamports ?? '0'), roundTripLossBps: Number(assessment?.conservativeRoundTripLossBps ?? assessment?.roundTripLossBps ?? 0),
    walletUniqueMintSample: wallet.length, globalUniqueMintSample: global.length,
    distinctFreshWallets: new Set((candidate.sourceWallets || []).map((item) => item.address || item)).size,
    independentClusterCount: clusters.length, clusterAdjustedWeight, walletClusters: clusters,
    positiveReasons: positiveReasons.slice(0, 3), negativeReasons: negativeReasons.slice(0, 3),
    narrativeContext: { available: false, value: null }, momentumState: { available: false, value: null },
    explicitEntryAndExitCostsSol,
    generatedAt: decisionAt
  };
}

module.exports = { betaPosterior, clusteredOutcomes, correlatedClusters, evaluateBrain, evidenceGrade, winsorizedMean };
