'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = {
  bind: '127.0.0.1',
  port: 17333,
  startingBalanceSol: 2,
  tradeSizeUsd: 14,
  useFixedTradeSizeSol: false,
  fixedTradeSizeSol: 0.013,
  defaultOrderSol: 0.02,
  paper: {
    slippageBps: 75,
    platformFeeBps: 100,
    networkFeeSol: 0.000005,
    priorityFeeSol: 0.0001,
    detectionToDecisionMs: 100,
    latencyMs: 150,
    maxPriceAgeMs: 10_000,
    realisticSlippageBps: 40,
    stopArmingDelayMs: 5000,
    stopArmingMinQuotePolls: 2
  },
  follow: {
    enabledOnStart: false,
    mode: 'mirror-wallet-lifecycle',
    orderSolPerWallet: 0.02,
    maxOpenLots: 25,
    acceptVisibleWalletsWhenListEmpty: true
  },
  bot: {
    autoStart: true,
    useGeneratedWallets: true,
    orderSol: 0.02,
    maxOpenPositions: 5,
    minimumLiquidityUsd: 15000,
    shadowConsensusPct: 30,
    adverseHistoryVetoConfidence: 0.65,
    liquidityCollapseRatio: 0.25,
    liquidityCollapseFloorUsd: 5000,
    normal: { walletCount: 4, weightedConsensusPct: 10, windowSeconds: 60 },
    strong: { walletCount: 4, weightedConsensusPct: 15, windowSeconds: 45 },
    // "Interesting enough to observe", not "buy" - a qualifying market update still goes through
    // the same fresh/security/executable/risk gates as a wallet signal. Dormant until a market
    // data source actually populates volumeUsd/feesSol/socialViews/socialComments/ageMinutes -
    // page-bridge.js currently only reports priceUsd/marketCapUsd, so this tier logic is real and
    // tested but will not fire in practice until that DOM/data feed is extended.
    discovery: {
      enabled: true,
      brandNew: { minMarketCapUsd: 6000, maxMarketCapUsd: 60000, minVolumeUsd: 3000, minFeesSol: 0.1, requireSocial: true },
      soonMigrated: { minMarketCapUsd: 20000, maxAgeMinutes: 600, minFeesSol: 2 },
      migrated: { minMarketCapUsd: 28000, minFeesSol: 3, requireSocial: true }
    },
    exit: {
      hardStopPct: 10,
      maxHoldBeforeTp1Minutes: 15,
      tp1Pct: 15,
      finalTakeProfitPct: 50,
      trailingStopPct: 15,
      maxTotalHoldMinutes: 30
    },
    paperAggressive: {
      strategyVersion: 'PAPER_AGGRESSIVE_BAYES_V1',
      controlStrategyVersion: 'PAPER_AGGRESSIVE_CONTROL',
      orderSol: 0.01,
      maxOpenPositions: 5,
      reentryCooldownSeconds: 15,
      priceWaitTimeoutSeconds: 10,
      priceRetryMs: 1000,
      openSampleMs: 5000,
      outcomeSampleMs: 30000,
      outcomeWindowMinutes: 60
    },
    brain: {
      priorEquivalentSampleSize: 20,
      correlatedCommonMintMinimum: 2,
      roundTripWarningBps: 1000,
      materialNegativeSol: 0.002,
      maximumReentriesPerMint: 1,
      respectBrainHardGate: false
    },
    refined: {
      strategyVersion: 'FLOWDECK_FINAL_V1',
      stopModelVersion: 'DYNAMIC_STOP_V1',
      consensusWindowSeconds: 15,
      // The single freshness gate for the actionable event (wallet buy / GMGN qualifying
      // observation), never token/creation age. >30s since that event and the opportunity
      // is stale; <=30s and it's still eligible regardless of how old the token itself is.
      opportunityWindowMs: 30000,
      executionDelayDefaultMs: 750,
      executionDelayMinMs: 250,
      executionDelayMaxMs: 2000,
      minStopPct: 8,
      maxStopPct: 30,
      fallbackStopPct: 12,
      winnerMaePriorPct: 6,
      regimePriorSamples: 20,
      maxLossSol: 0.05,
      allowRiskTooWideResearch: false,
      proofWindowDefaultMs: 10000,
      proofWindowMinMs: 5000,
      proofWindowMaxMs: 20000,
      breakevenMfePct: 8,
      runnerTrailSigmaMultiplier: 1.5,
      runnerTrailMinPct: 6,
      runnerTrailMaxPct: 15,
      temporarilyUnsellableRetryMs: 5000,
      maxRecentCandidates: 200,
      maxIntents: 2000,
      maxFills: 2000,
      maxClosedTrades: 5000
    }
  },
  jupiter: {
    baseUrl: 'https://api.jup.ag/swap/v2',
    paperTakerAddress: '',
    timeoutMs: 5000,
    quoteMaxAgeMs: 3000,
    cacheMs: 500,
    maxCacheEntries: 500,
    // Lowered from 4/4: at 4rps Jupiter's real API was 429-ing 22.6% of our calls under live
    // 40-wallet load, and every retry-with-backoff burned 5-13s of the 10s freshness budget on
    // candidates that had already cleared risk (observed directly on STALE_QUOTE rejects). This
    // is the real sustained rate the live server tolerates from us, not a local queue limit.
    rateLimitCapacity: 3,
    requestsPerSecond: 3,
    // jupiter-client.js reserves 60% of this for exit-priority quotes, so entryConcurrency =
    // floor(maxConcurrency * 0.4). At 3 that floors to 1 concurrent entry-side Jupiter call
    // system-wide, serializing every candidate's quote/revalidate behind a single slot even
    // with zero open positions competing for it - the direct cause of SIGNAL_EXPIRED_BEFORE_FILL
    // timeouts (observed 12-17s dispatch delay ahead of a ~300ms real call). requestsPerSecond
    // still caps the real outbound rate to Jupiter, so this only removes local head-of-line
    // blocking, it does not increase load on Jupiter's API.
    maxConcurrency: 10,
    maxQueueSize: 300,
    maxAttempts: 3,
    backoffMaxMs: 30_000,
    solUsdRefreshMs: 45_000,
    paperExecutionHaircutBps: 0,
    routeLossGraceMs: 15000,
    farQuoteIntervalMs: 5000,
    nearQuoteIntervalMs: 1000,
    counterfactualHorizonsMs: [5000, 15000, 30000, 60000, 180000, 300000, 900000]
  },
  gmgn: {
    cliPath: 'gmgn-cli',
    timeoutMs: 15000,
    enabled: true,
    cacheMs: 300_000,
    maxCacheEntries: 200,
    maxQueueSize: 100,
    requestsPerSecond: 4,
    rateLimitCapacity: 4,
    discoveryEnabled: false
  },
  rpc: {
    httpUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    commitment: 'confirmed',
    processedCommitment: 'processed',
    confirmationCommitment: 'confirmed',
    fetchConcurrency: 5,
    rateLimitCapacity: 6,
    requestsPerSecond: 5,
    catchupLimit: 10,
    maxQueueSize: 500,
    prefilterSwapLogs: true,
    maxAttempts: 3,
    backoffMaxMs: 15000,
    quarantineMinimumSamples: 5,
    quarantineFailureRatio: 0.6,
    quarantineMs: 60_000,
    confirmationPollMs: 3000,
    confirmationTimeoutMs: 60000
  },
  priceFallback: {
    enabled: true,
    pollMs: 3000,
    maxRequestsPerSecond: 4
  },
  live: {
    enabled: false,
    signerConfigured: false,
    minimumBalanceSol: 0.1
  },
  wallets: []
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isObject(value) && isObject(base[key])) result[key] = merge(base[key], value);
    else result[key] = value;
  }
  return result;
}

function finite(value, fallback, minimum = -Infinity, maximum = Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeConfig(raw = {}) {
  const config = merge(DEFAULT_CONFIG, raw);
  config.bind = config.bind === '127.0.0.1' || config.bind === 'localhost' ? config.bind : '127.0.0.1';
  config.port = Math.trunc(finite(config.port, DEFAULT_CONFIG.port, 1024, 65535));
  config.startingBalanceSol = finite(config.startingBalanceSol, 2, 0.001, 1_000_000);
  config.tradeSizeUsd = finite(config.tradeSizeUsd, 5, 0.01, 1_000_000);
  config.useFixedTradeSizeSol = Boolean(config.useFixedTradeSizeSol);
  config.fixedTradeSizeSol = finite(config.fixedTradeSizeSol, 0.013, 0.000001, 1_000_000);
  config.defaultOrderSol = finite(config.defaultOrderSol, 0.02, 0.000001, 1_000_000);
  config.paper.slippageBps = finite(config.paper.slippageBps, 75, 0, 10_000);
  config.paper.platformFeeBps = finite(config.paper.platformFeeBps, 0, 0, 10_000);
  config.paper.networkFeeSol = finite(config.paper.networkFeeSol, 0.000005, 0, 10);
  config.paper.priorityFeeSol = finite(config.paper.priorityFeeSol, 0.0001, 0, 10);
  config.paper.detectionToDecisionMs = finite(config.paper.detectionToDecisionMs, 100, 0, 60_000);
  config.paper.latencyMs = finite(config.paper.latencyMs, 150, 0, 60_000);
  config.paper.maxPriceAgeMs = finite(config.paper.maxPriceAgeMs, 10_000, 250, 300_000);
  config.paper.realisticSlippageBps = finite(config.paper.realisticSlippageBps, 40, 0, 10_000);
  config.paper.stopArmingDelayMs = finite(config.paper.stopArmingDelayMs, 5000, 0, 300_000);
  config.paper.stopArmingMinQuotePolls = Math.trunc(finite(config.paper.stopArmingMinQuotePolls, 2, 0, 100));
  config.follow.orderSolPerWallet = finite(config.follow.orderSolPerWallet, 0.02, 0.000001, 1_000_000);
  config.follow.maxOpenLots = Math.trunc(finite(config.follow.maxOpenLots, 25, 1, 10_000));
  config.follow.enabledOnStart = Boolean(config.follow.enabledOnStart);
  config.follow.acceptVisibleWalletsWhenListEmpty = Boolean(config.follow.acceptVisibleWalletsWhenListEmpty);
  config.bot.useGeneratedWallets = config.bot.useGeneratedWallets !== false;
  config.bot.autoStart = config.bot.autoStart !== false;
  config.bot.orderSol = finite(config.bot.orderSol, config.defaultOrderSol, 0.000001, 1_000_000);
  config.bot.maxOpenPositions = Math.trunc(finite(config.bot.maxOpenPositions, 5, 1, 100));
  config.bot.minimumLiquidityUsd = finite(config.bot.minimumLiquidityUsd, 15000, 0, 1_000_000_000);
  config.bot.shadowConsensusPct = finite(config.bot.shadowConsensusPct, 30, 0, 100);
  config.bot.adverseHistoryVetoConfidence = finite(config.bot.adverseHistoryVetoConfidence, 0.65, 0, 1);
  config.bot.liquidityCollapseRatio = finite(config.bot.liquidityCollapseRatio, 0.25, 0, 1);
  config.bot.liquidityCollapseFloorUsd = finite(config.bot.liquidityCollapseFloorUsd, 5000, 0, 1_000_000_000);
  config.bot.normal.walletCount = Math.trunc(finite(config.bot.normal.walletCount, 4, 1, 100));
  config.bot.normal.weightedConsensusPct = finite(config.bot.normal.weightedConsensusPct, 10, 0, 100);
  config.bot.normal.windowSeconds = finite(config.bot.normal.windowSeconds, 60, 1, 3600);
  config.bot.strong.walletCount = Math.trunc(finite(config.bot.strong.walletCount, 4, 1, 100));
  config.bot.strong.weightedConsensusPct = finite(config.bot.strong.weightedConsensusPct, 15, 0, 100);
  config.bot.strong.windowSeconds = finite(config.bot.strong.windowSeconds, 45, 1, 3600);
  config.bot.discovery.enabled = config.bot.discovery.enabled !== false;
  for (const tier of ['brandNew', 'soonMigrated', 'migrated']) {
    const source = config.bot.discovery[tier] || {};
    const fallback = DEFAULT_CONFIG.bot.discovery[tier];
    config.bot.discovery[tier] = {
      minMarketCapUsd: finite(source.minMarketCapUsd, fallback.minMarketCapUsd, 0, 1e12),
      maxMarketCapUsd: finite(source.maxMarketCapUsd, fallback.maxMarketCapUsd ?? Infinity, 0, Infinity),
      minVolumeUsd: finite(source.minVolumeUsd, fallback.minVolumeUsd ?? 0, 0, 1e12),
      minFeesSol: finite(source.minFeesSol, fallback.minFeesSol ?? 0, 0, 1e6),
      maxAgeMinutes: finite(source.maxAgeMinutes, fallback.maxAgeMinutes ?? Infinity, 0, Infinity),
      requireSocial: Boolean(source.requireSocial ?? fallback.requireSocial)
    };
  }
  for (const key of ['hardStopPct', 'tp1Pct', 'finalTakeProfitPct', 'trailingStopPct']) config.bot.exit[key] = finite(config.bot.exit[key], DEFAULT_CONFIG.bot.exit[key], 0.01, 1000);
  for (const key of ['maxHoldBeforeTp1Minutes', 'maxTotalHoldMinutes']) config.bot.exit[key] = finite(config.bot.exit[key], DEFAULT_CONFIG.bot.exit[key], 0.01, 1440);
  config.bot.paperAggressive.strategyVersion = String(config.bot.paperAggressive.strategyVersion || 'PAPER_AGGRESSIVE_BAYES_V1');
  config.bot.paperAggressive.controlStrategyVersion = String(config.bot.paperAggressive.controlStrategyVersion || 'PAPER_AGGRESSIVE_CONTROL');
  config.bot.paperAggressive.orderSol = finite(config.bot.paperAggressive.orderSol, 0.01, 0.000001, 1_000_000);
  config.bot.paperAggressive.maxOpenPositions = Math.trunc(finite(config.bot.paperAggressive.maxOpenPositions, 5, 1, 1000));
  config.bot.paperAggressive.reentryCooldownSeconds = finite(config.bot.paperAggressive.reentryCooldownSeconds, 15, 0, 86400);
  config.bot.paperAggressive.priceWaitTimeoutSeconds = finite(config.bot.paperAggressive.priceWaitTimeoutSeconds, 10, 1, 600);
  config.bot.paperAggressive.priceRetryMs = finite(config.bot.paperAggressive.priceRetryMs, 1000, 100, 60000);
  config.bot.paperAggressive.openSampleMs = finite(config.bot.paperAggressive.openSampleMs, 5000, 1000, 60000);
  config.bot.paperAggressive.outcomeSampleMs = finite(config.bot.paperAggressive.outcomeSampleMs, 30000, 1000, 600000);
  config.bot.paperAggressive.outcomeWindowMinutes = finite(config.bot.paperAggressive.outcomeWindowMinutes, 60, 1, 1440);
  config.bot.brain.priorEquivalentSampleSize = finite(config.bot.brain.priorEquivalentSampleSize, 20, 2, 1000);
  config.bot.brain.correlatedCommonMintMinimum = Math.trunc(finite(config.bot.brain.correlatedCommonMintMinimum, 2, 1, 100));
  config.bot.brain.roundTripWarningBps = finite(config.bot.brain.roundTripWarningBps, 1000, 0, 10000);
  config.bot.brain.materialNegativeSol = finite(config.bot.brain.materialNegativeSol, 0.002, 0, 1000);
  config.bot.brain.maximumReentriesPerMint = Math.trunc(finite(config.bot.brain.maximumReentriesPerMint, 1, 0, 10));
  config.bot.brain.respectBrainHardGate = Boolean(config.bot.brain.respectBrainHardGate);
  const refined = config.bot.refined;
  refined.strategyVersion = String(refined.strategyVersion || 'FLOWDECK_FINAL_V1');
  refined.stopModelVersion = 'DYNAMIC_STOP_V1';
  refined.consensusWindowSeconds = finite(refined.consensusWindowSeconds, 15, 1, 300);
  refined.opportunityWindowMs = finite(refined.opportunityWindowMs, 30000, 1000, 300000);
  refined.executionDelayDefaultMs = finite(refined.executionDelayDefaultMs, 750, 250, 2000);
  refined.executionDelayMinMs = finite(refined.executionDelayMinMs, 250, 250, 2000);
  refined.executionDelayMaxMs = finite(refined.executionDelayMaxMs, 2000, refined.executionDelayMinMs, 2000);
  refined.executionDelayDefaultMs = Math.max(refined.executionDelayMinMs, Math.min(refined.executionDelayMaxMs, refined.executionDelayDefaultMs));
  for (const [key, fallback, minimum, maximum] of [
    ['minStopPct', 8, 0.1, 100], ['maxStopPct', 20, 0.1, 100], ['fallbackStopPct', 12, 0.1, 100],
    ['winnerMaePriorPct', 6, 0, 100], ['maxLossSol', 0.003, 0.000001, 1000],
    ['runnerTrailSigmaMultiplier', 1.5, 0, 10], ['runnerTrailMinPct', 6, 0.1, 100], ['runnerTrailMaxPct', 15, 0.1, 100]
  ]) refined[key] = finite(refined[key], fallback, minimum, maximum);
  refined.maxStopPct = Math.max(refined.minStopPct, refined.maxStopPct);
  refined.fallbackStopPct = Math.max(refined.minStopPct, Math.min(refined.maxStopPct, refined.fallbackStopPct));
  refined.runnerTrailMaxPct = Math.max(refined.runnerTrailMinPct, refined.runnerTrailMaxPct);
  refined.regimePriorSamples = Math.trunc(finite(refined.regimePriorSamples, 20, 1, 10000));
  refined.allowRiskTooWideResearch = Boolean(refined.allowRiskTooWideResearch);
  refined.proofWindowMinMs = finite(refined.proofWindowMinMs, 5000, 1000, 60000);
  refined.proofWindowMaxMs = finite(refined.proofWindowMaxMs, 20000, refined.proofWindowMinMs, 120000);
  refined.proofWindowDefaultMs = finite(refined.proofWindowDefaultMs, 10000, refined.proofWindowMinMs, refined.proofWindowMaxMs);
  refined.breakevenMfePct = finite(refined.breakevenMfePct, 8, 0, 1000);
  refined.temporarilyUnsellableRetryMs = finite(refined.temporarilyUnsellableRetryMs, 5000, 250, 300000);
  for (const [key, fallback, maximum] of [['maxRecentCandidates', 200, 10000], ['maxIntents', 2000, 100000], ['maxFills', 2000, 100000], ['maxClosedTrades', 5000, 100000]]) {
    refined[key] = Math.trunc(finite(refined[key], fallback, 10, maximum));
  }
  config.jupiter.baseUrl = String(config.jupiter.baseUrl || 'https://api.jup.ag/swap/v2').replace(/\/$/, '');
  config.jupiter.paperTakerAddress = String(config.jupiter.paperTakerAddress || '').trim();
  config.jupiter.timeoutMs = finite(config.jupiter.timeoutMs, 5000, 250, 60000);
  config.jupiter.quoteMaxAgeMs = finite(config.jupiter.quoteMaxAgeMs, 3000, 100, 60000);
  config.jupiter.cacheMs = finite(config.jupiter.cacheMs, 500, 0, 10000);
  config.jupiter.maxCacheEntries = Math.trunc(finite(config.jupiter.maxCacheEntries, 500, 10, 5000));
  config.jupiter.rateLimitCapacity = Math.trunc(finite(config.jupiter.rateLimitCapacity, 4, 1, 100));
  config.jupiter.requestsPerSecond = finite(config.jupiter.requestsPerSecond, 4, 0.1, 100);
  config.jupiter.maxConcurrency = Math.trunc(finite(config.jupiter.maxConcurrency, 3, 1, 32));
  config.jupiter.maxQueueSize = Math.trunc(finite(config.jupiter.maxQueueSize, 300, 10, 10000));
  config.jupiter.maxAttempts = Math.trunc(finite(config.jupiter.maxAttempts, 3, 1, 10));
  config.jupiter.backoffMaxMs = finite(config.jupiter.backoffMaxMs, 30000, 500, 300000);
  config.jupiter.solUsdRefreshMs = finite(config.jupiter.solUsdRefreshMs, 45000, 30000, 60000);
  config.jupiter.paperExecutionHaircutBps = finite(config.jupiter.paperExecutionHaircutBps, 0, 0, 10000);
  config.jupiter.routeLossGraceMs = finite(config.jupiter.routeLossGraceMs, 15000, 0, 300000);
  config.jupiter.farQuoteIntervalMs = finite(config.jupiter.farQuoteIntervalMs, 5000, 250, 60000);
  config.jupiter.nearQuoteIntervalMs = finite(config.jupiter.nearQuoteIntervalMs, 1000, 100, 60000);
  config.jupiter.counterfactualHorizonsMs = Array.isArray(config.jupiter.counterfactualHorizonsMs)
    ? [...new Set(config.jupiter.counterfactualHorizonsMs.map((value) => Math.trunc(finite(value, 0, 1000, 86400000))).filter(Boolean))].sort((a, b) => a - b)
    : DEFAULT_CONFIG.jupiter.counterfactualHorizonsMs;
  config.gmgn.cliPath = String(config.gmgn.cliPath || 'gmgn-cli');
  config.gmgn.timeoutMs = finite(config.gmgn.timeoutMs, 15000, 1000, 120000);
  config.gmgn.enabled = config.gmgn.enabled !== false;
  config.gmgn.cacheMs = finite(config.gmgn.cacheMs, 300000, 30000, 3600000);
  config.gmgn.maxCacheEntries = Math.trunc(finite(config.gmgn.maxCacheEntries, 200, 10, 2000));
  config.gmgn.maxQueueSize = Math.trunc(finite(config.gmgn.maxQueueSize, 100, 1, 1000));
  config.gmgn.requestsPerSecond = finite(config.gmgn.requestsPerSecond, 2, 0.1, 20);
  config.gmgn.rateLimitCapacity = Math.trunc(finite(config.gmgn.rateLimitCapacity, 1, 1, 20));
  config.gmgn.discoveryEnabled = false;
  config.rpc.processedCommitment = 'processed';
  config.rpc.confirmationCommitment = ['confirmed', 'finalized'].includes(config.rpc.confirmationCommitment) ? config.rpc.confirmationCommitment : 'confirmed';
  config.rpc.fetchConcurrency = Math.trunc(finite(config.rpc.fetchConcurrency, 2, 1, 32));
  config.rpc.rateLimitCapacity = Math.trunc(finite(config.rpc.rateLimitCapacity, 1, 1, 100));
  config.rpc.requestsPerSecond = finite(config.rpc.requestsPerSecond, 2, 0.1, 100);
  config.rpc.catchupLimit = Math.trunc(finite(config.rpc.catchupLimit, 10, 1, 1000));
  config.rpc.maxQueueSize = Math.trunc(finite(config.rpc.maxQueueSize, 500, 10, 10000));
  config.rpc.prefilterSwapLogs = config.rpc.prefilterSwapLogs !== false;
  config.rpc.maxAttempts = Math.trunc(finite(config.rpc.maxAttempts, 3, 1, 10));
  config.rpc.backoffMaxMs = finite(config.rpc.backoffMaxMs, 15000, 500, 60000);
  config.rpc.quarantineMinimumSamples = Math.trunc(finite(config.rpc.quarantineMinimumSamples, 5, 3, 100));
  config.rpc.quarantineFailureRatio = finite(config.rpc.quarantineFailureRatio, 0.6, 0.1, 1);
  config.rpc.quarantineMs = finite(config.rpc.quarantineMs, 60000, 1000, 3600000);
  config.rpc.confirmationPollMs = finite(config.rpc.confirmationPollMs, 3000, 250, 60000);
  config.rpc.confirmationTimeoutMs = finite(config.rpc.confirmationTimeoutMs, 60000, 1000, 600000);
  config.live.enabled = Boolean(config.live.enabled);
  config.live.signerConfigured = Boolean(config.live.signerConfigured);
  config.live.minimumBalanceSol = finite(config.live.minimumBalanceSol, 0.1, 0, 1000000);
  config.wallets = Array.isArray(config.wallets)
    ? config.wallets
        .filter((wallet) => wallet && typeof wallet.address === 'string')
        .map((wallet) => ({
          address: wallet.address.trim(),
          label: String(wallet.label || '').trim(),
          enabled: wallet.enabled !== false,
          weight: finite(wallet.weight ?? wallet.finalWeight, 1, 0.01, 100)
        }))
        .filter((wallet) => wallet.address)
    : [];
  return config;
}

function loadConfig(projectRoot) {
  const configPath = process.env.FLOWDECK_CONFIG || path.join(projectRoot, 'config.json');
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const config = normalizeConfig(raw);
  // Followed/tracked GMGN wallets (captured live by the extension from the logged-in account's
  // own watchlist, see /api/followed-wallets) are the primary roster. The generated ~40-wallet
  // Dune roster only loads when no followed-wallet roster has ever been captured.
  const followedPath = path.join(projectRoot, 'data', 'wallets.followed.json');
  if (fs.existsSync(followedPath)) {
    const followed = JSON.parse(fs.readFileSync(followedPath, 'utf8'));
    if (Array.isArray(followed.wallets) && followed.wallets.length) {
      config.wallets = followed.wallets.map((wallet) => ({
        address: wallet.address, label: wallet.label || 'GMGN Followed',
        enabled: wallet.enabled !== false, weight: finite(wallet.weight, 1, 0.5, 2)
      }));
      config.followedWalletRoster = { path: followedPath, walletCount: config.wallets.length };
      return { config, configPath };
    }
  }
  const generatedPath = path.join(projectRoot, 'data', 'wallets.generated.json');
  if (config.bot.useGeneratedWallets && fs.existsSync(generatedPath)) {
    const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    if (Array.isArray(generated.wallets) && generated.wallets.length) {
      config.wallets = generated.wallets.map((wallet) => ({
        address: wallet.address,
        label: wallet.label || `Dune candidate ${wallet.rank || ''}`.trim(),
        enabled: wallet.enabled !== false,
        weight: finite(wallet.finalWeight, 1, 0.5, 2)
      }));
      config.generatedWalletRoster = { path: generatedPath, candidateCount: config.wallets.length };
    }
  }
  return { config, configPath };
}

module.exports = { DEFAULT_CONFIG, loadConfig, merge, normalizeConfig };
