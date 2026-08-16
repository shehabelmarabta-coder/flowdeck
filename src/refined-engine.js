'use strict';

const { atomic, atomicToDecimalString, decimalToAtomic, entryLamportsForUsd, SOL_MINT, usdMicrosFromLamports } = require('./atomic');
const { betaPosterior, evaluateBrain } = require('./brain');
const { immutableSnapshot } = require('./decision-snapshot');
const { modelledFillOutput, percentile } = require('./jupiter-client');
const { dynamicStop, percentReturns, runnerTrailPct, volatilityPct } = require('./risk-model');

const STATE_SCHEMA = 'flowdeck-final-state-v1';
const FILL_QUALITY = Object.freeze({
  SIMULATED_BUILDABLE: 'SIMULATED_BUILDABLE',
  BUILDABLE_UNSIMULATED: 'BUILDABLE_UNSIMULATED',
  QUOTE_PARITY: 'QUOTE_PARITY',
  NO_FILL: 'NO_FILL'
});
const IN_FLIGHT = new Set(['DECIDED', 'QUOTING', 'BUILDING', 'SIMULATING', 'WAITING_LANDING', 'REVALIDATING', 'EXECUTING']);

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function nowIso(timestamp) { return new Date(timestamp).toISOString(); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function boundedPush(array, value, maximum) { array.push(value); if (array.length > maximum) array.splice(0, array.length - maximum); return value; }
function safeAtomic(value, fallback = '0') { try { return atomic(value); } catch { return atomic(fallback); } }

function compactActivity(activity) {
  const seenOperational = new Set();
  const retained = [];
  for (const event of [...(activity || [])].reverse()) {
    if (event?.type === 'SOURCE_EVIDENCE') {
      const key = `${event.status || ''}:${event.reason || ''}`;
      if (seenOperational.has(key)) continue;
      seenOperational.add(key);
    }
    retained.push(event);
    if (retained.length >= 200) break;
  }
  return retained.reverse();
}

function minimumOutput(quote, fallbackSlippageBps) {
  if (/^\d+$/.test(String(quote?.minimumOutputAtomic || '')) && atomic(quote.minimumOutputAtomic) > 0n) return String(quote.minimumOutputAtomic);
  const out = safeAtomic(quote?.outAmountAtomic);
  const bps = BigInt(clamp(Math.trunc(Number(quote?.slippageBps ?? fallbackSlippageBps ?? 0)), 0, 10_000));
  return (out * (10_000n - bps) / 10_000n).toString();
}

function sanitizeQuote(quote) {
  if (!quote) return null;
  const { transaction, ...safe } = quote;
  return { ...safe, transactionPresent: Boolean(quote.transactionPresent || transaction) };
}

function liquidityBand(value) {
  const liquidity = Number(value);
  if (!Number.isFinite(liquidity)) return 'UNKNOWN';
  if (liquidity < 25_000) return 'LOW';
  if (liquidity < 100_000) return 'MEDIUM';
  return 'HIGH';
}

function initialState(config, clock, sequence = 0, closedTrades = [], sessionHistory = []) {
  const at = clock();
  const starting = decimalToAtomic(config.startingBalanceSol, 9).toString();
  return {
    schemaVersion: STATE_SCHEMA,
    strategyVersion: config.bot.refined.strategyVersion,
    mode: 'BOT_PAPER',
    autoRun: Boolean(config.bot.autoStart),
    sequence,
    session: { id: `session_${at}_${sequence + 1}`, startedAt: at, startingBalanceLamports: starting, balanceLamports: starting, rentOutstandingLamports: '0' },
    candidates: [], intents: [], positions: [], fills: [], closedTrades, sessionHistory,
    performance: { signals: 0, candidates: 0, paperFills: 0, rateLimits: 0 },
    seenSignalKeys: [], activity: [],
    latency: { signalToDecisionMs: [], signalToBuildMs: [], decisionToFillMs: [], signalToFillMs: [], quoteAgeMs: [] },
    parity: { routeAttempts: 0, exactRoutes: 0, buildable: 0, simulationAttempts: 0, simulationAccepted: 0, revalidations: 0, revalidationSuccesses: 0, feeComplete: 0, sellRouteAttempts: 0, sellRoutes: 0, staleSignalDrops: 0, fillQualities: { SIMULATED_BUILDABLE: 0, BUILDABLE_UNSIMULATED: 0, QUOTE_PARITY: 0, NO_FILL: 0 } },
    services: {}, restartCount: 0
  };
}

class RefinedPaperEngine {
  constructor({ config, store = null, auditWriter = null, trajectoryIndex = null, clock = () => Date.now(), waitImpl = wait, simulator = null, jupiterClient = null, researchProvider = null, liveAdapter = null } = {}) {
    this.config = config;
    this.store = store;
    this.auditWriter = auditWriter;
    this.trajectoryIndex = trajectoryIndex;
    this.clock = clock;
    this.wait = waitImpl;
    this.simulator = simulator;
    this.jupiterClient = jupiterClient;
    this.researchProvider = researchProvider;
    this.liveAdapter = liveAdapter;
    this.markets = new Map();
    this.marketSeries = new Map();
    this.quoteSeries = new Map();
    this.evidenceAggregation = new Map();
    this.locks = new Set();
    this.resetting = false;
    this.timer = null;
    this.persistTimer = null;
    this.retryTimers = new Map();
    const loaded = store?.loadState?.();
    this.state = loaded?.schemaVersion === STATE_SCHEMA ? this._hydrate(loaded) : initialState(config, clock);
    this.state.restartCount = Number(this.state.restartCount || 0) + 1;
    for (const intent of this.state.intents) {
      if (IN_FLIGHT.has(intent.status)) {
        intent.status = 'INTERRUPTED'; intent.fillQuality = FILL_QUALITY.NO_FILL; intent.reason = 'RESTART_INTERRUPTED_BEFORE_FILL'; intent.completedAt = this.clock();
        this.state.parity.fillQualities.NO_FILL += 1;
      }
    }
    if (loaded && loaded.schemaVersion !== STATE_SCHEMA) {
      this._event('LEGACY_STATE_DISCARDED', { status: 'DISCARDED', reason: String(loaded.schemaVersion || 'UNKNOWN_SCHEMA') });
    }
    this._persist();
  }

  _hydrate(loaded) {
    const fresh = initialState(this.config, this.clock, Number(loaded.sequence || 0), Array.isArray(loaded.closedTrades) ? loaded.closedTrades : []);
    const state = { ...fresh, ...loaded };
    for (const key of ['candidates', 'intents', 'positions', 'fills', 'closedTrades', 'sessionHistory', 'seenSignalKeys', 'activity']) if (!Array.isArray(state[key])) state[key] = [];
    state.activity = compactActivity(state.activity);
    state.latency = { ...fresh.latency, ...(loaded.latency || {}) };
    state.parity = { ...fresh.parity, ...(loaded.parity || {}), fillQualities: { ...fresh.parity.fillQualities, ...(loaded.parity?.fillQualities || {}) } };
    state.performance = { ...fresh.performance, ...(loaded.performance || {}) };
    state.session = { ...fresh.session, ...(loaded.session || {}) };
    state.services = loaded.services && typeof loaded.services === 'object' ? loaded.services : {};
    return state;
  }

  setExecutionServices({ jupiterClient, simulator } = {}) {
    if (jupiterClient !== undefined) this.jupiterClient = jupiterClient;
    if (simulator !== undefined) this.simulator = simulator;
  }

  setResearchProvider(researchProvider) { this.researchProvider = researchProvider || null; }

  setExecutionAdapters() { /* This engine owns the single paper/live execution boundary. */ }

  _persist() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.store?.saveState?.(this.state);
  }

  _persistSoon() {
    if (!this.store?.saveState || this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this._persist(); }, 250);
    this.persistTimer.unref?.();
  }

  _id(prefix) {
    this.state.sequence += 1;
    return `${prefix}_${this.state.session.id}_${this.state.sequence}`;
  }

  _event(type, { decisionId = '', positionId = '', mint = '', side = '', status = '', reason = '', payload = {} } = {}) {
    const timestamp = this.clock();
    const event = { id: this._id('event'), timestamp, type, decisionId, positionId, mint, side, status, reason, payload };
    boundedPush(this.state.activity, event, 200);
    try {
      this.auditWriter?.writeEvent?.({
        session_id: this.state.session.id, event_id: event.id, timestamp_utc: nowIso(timestamp), event_type: type,
        decision_id: decisionId, position_id: positionId, mint, side, status, reason, payload_json: payload
      });
    } catch (error) { this.state.services = { ...this.state.services, audit: 'degraded', auditError: String(error.message || error).slice(0, 300) }; }
    return event;
  }

  setServiceStatus(status) { this.state.services = { ...this.state.services, ...status }; }

  recordObservation(evidence) {
    const useful = ['DECODE_FAILED', 'TRANSACTION_FETCH_FAILED', 'PROCESSED_LATER_FAILED', 'RPC_DATA_GAP', 'MISSED_BACKFILLED', 'WALLET_SOURCE_QUARANTINED'].includes(evidence?.type);
    if (!useful) return { status: 'ignored', reason: 'non-trading-rpc-telemetry' };
    const type = String(evidence.type || 'SOURCE_EVIDENCE');
    const reason = String(evidence.error || evidence.reason || '');
    const summary = this.state.services.sourceEvidence || { counts: {}, suppressed: 0, lastType: null, lastReason: null, lastAt: null };
    summary.counts[type] = Number(summary.counts[type] || 0) + 1;
    summary.lastType = type; summary.lastReason = reason; summary.lastAt = this.clock();
    this.state.services.sourceEvidence = summary;
    if (['TRANSACTION_FETCH_FAILED', 'MISSED_BACKFILLED'].includes(type)) {
      const key = `${type}:${reason}`;
      const aggregate = this.evidenceAggregation.get(key) || { lastEmittedAt: 0, suppressed: 0 };
      if (this.clock() - aggregate.lastEmittedAt < 5000) {
        aggregate.suppressed += 1; summary.suppressed += 1; this.evidenceAggregation.set(key, aggregate);
        return { status: 'aggregated', type, suppressed: aggregate.suppressed };
      }
      evidence = { ...evidence, aggregatedSincePrevious: aggregate.suppressed };
      aggregate.lastEmittedAt = this.clock(); aggregate.suppressed = 0; this.evidenceAggregation.set(key, aggregate);
    }
    this._event('SOURCE_EVIDENCE', { status: type, reason, payload: evidence });
    this._persistSoon();
    return { status: 'recorded' };
  }

  setAutoRun(enabled) {
    const next = Boolean(enabled);
    if (!next) {
      for (const candidate of this.state.candidates.filter((item) => ['OBSERVED', 'EVALUATING', 'WAITING_FOR_ROUTE'].includes(item.status))) {
        candidate.status = 'EXPIRED'; candidate.reason = 'AUTOMATION_PAUSED'; candidate.completedAt = this.clock();
        this._clearRetry(candidate.mint);
        this._event('CANDIDATE_EXPIRED', { mint: candidate.mint, side: 'BUY', status: candidate.status, reason: candidate.reason, payload: { candidateId: candidate.id } });
      }
    }
    this.state.autoRun = next;
    this._event(this.state.autoRun ? 'AUTOMATION_RESUMED' : 'AUTOMATION_PAUSED', { status: this.state.autoRun ? 'RUNNING' : 'PAUSED' });
    this._persist();
    return { status: 'updated', autoRun: this.state.autoRun, mode: this.state.mode };
  }

  setMode(mode) {
    if (String(mode) === 'BOT_PAPER') { this.state.mode = 'BOT_PAPER'; this._persist(); return { status: 'updated', mode: this.state.mode }; }
    if (String(mode) !== 'BOT_LIVE') return { status: 'blocked', reason: 'INVALID_MODE' };
    return this.checkLiveReadiness();
  }

  checkLiveReadiness() {
    const checks = {
      configured: Boolean(this.config.live.enabled), signer: Boolean(this.config.live.signerConfigured),
      adapter: Boolean(this.liveAdapter), explicitlyArmed: false, broadcastLock: true
    };
    return { status: 'blocked', reason: 'LIVE_BROADCAST_LOCKED_FOR_THIS_RELEASE_TASK', mode: this.state.mode, checks };
  }

  setFollow(enabled) { return this.setAutoRun(enabled); }
  setRisk() { return { status: 'blocked', reason: 'Risk is frozen per position by DYNAMIC_STOP_V1.' }; }
  setLimit() { return { status: 'blocked', reason: 'The final bot has no manual limit-order path.' }; }
  cancelLimit() { return { status: 'ignored', reason: 'no-limit-order' }; }

  _enabledWallet(address) { return this.config.wallets.find((wallet) => wallet.enabled !== false && wallet.address === address); }

  // Replaces the wallet roster with the caller's followed/tracked GMGN wallets, deduplicated.
  // Only ever called with a non-empty extracted list (see server.js) - the generated ~40-wallet
  // roster loaded at startup is the fallback simply by this never being called when extraction
  // fails, per the "40 = fallback only" requirement. Does not touch RPC subscriptions directly;
  // takes effect for signal matching immediately and durably on the next server start, exactly
  // like the existing generated-wallet roster already works.
  setFollowedWallets(addresses = []) {
    const seen = new Set();
    const wallets = [];
    for (const raw of addresses) {
      const address = String(raw || '').trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || seen.has(address)) continue;
      seen.add(address);
      wallets.push({ address, label: 'GMGN Followed', enabled: true, weight: 1 });
    }
    if (!wallets.length) return { status: 'ignored', reason: 'no-valid-followed-wallets', count: 0 };
    this.config.wallets = wallets;
    this._event('FOLLOWED_WALLETS_UPDATED', { mint: '', side: 'BUY', status: 'OBSERVED', payload: { count: wallets.length } });
    this._persist();
    return { status: 'updated', count: wallets.length };
  }

  async handleWalletSignal(signal = {}) {
    const mint = String(signal.mint || '').trim();
    const walletAddress = String(signal.wallet || signal.address || '').trim();
    const side = String(signal.side || '').toLowerCase();
    if (!mint || !walletAddress || !['buy', 'sell'].includes(side)) return { status: 'filtered', reason: 'invalid-decoded-trade' };
    const wallet = this._enabledWallet(walletAddress);
    if (!wallet) return { status: 'filtered', reason: 'wallet-not-enabled' };
    const signature = String(signal.signature || signal.id || '').trim();
    const dedupeKey = `${signature || 'no-signature'}:${walletAddress}:${mint}:${side}`;
    if (this.state.seenSignalKeys.includes(dedupeKey)) return { status: 'duplicate', reason: 'duplicate-wallet-trade' };
    boundedPush(this.state.seenSignalKeys, dedupeKey, 10_000);
    const signalAt = Number(signal.observedAt || signal.blockTime || signal.classificationAt || this.clock());
    if (signal.backfilled) {
      this._event('BACKFILL_EVIDENCE_ONLY', { mint, side, status: 'OBSERVED', reason: 'BACKFILL_NEVER_ENTERS', payload: { wallet: walletAddress, signature, signalAt } });
      this._persist();
      return { status: 'observed', reason: 'backfill-evidence-only' };
    }
    if (side !== 'buy') {
      this._event('WALLET_SELL_OBSERVED', { mint, side, status: 'OBSERVED', payload: { wallet: walletAddress, signature } }); this._persist();
      return { status: 'observed', reason: 'wallet-sells-do-not-force-paper-exit' };
    }
    this.state.performance.signals += 1;
    const signalAgeMs = Math.max(0, this.clock() - signalAt);
    if (signalAgeMs > this.config.bot.refined.opportunityWindowMs) {
      this.state.parity.staleSignalDrops += 1;
      this._event('STALE_SIGNAL_DROPPED', { mint, side, status: 'EXPIRED', reason: 'SIGNAL_OLDER_THAN_OPPORTUNITY_WINDOW', payload: { wallet: walletAddress, signature, signalAt, signalAgeMs } });
      this._persist();
      return { status: 'expired', reason: 'stale-signal', signalAgeMs };
    }
    const lastClose = [...this.state.closedTrades].reverse().find((trade) => trade.mint === mint)?.exitAt;
    if (lastClose && signalAt - Number(lastClose) < this.config.bot.paperAggressive.reentryCooldownSeconds * 1000) {
      this._event('CANDIDATE_EXPIRED', { mint, side, status: 'EXPIRED', reason: 'REENTRY_COOLDOWN_REQUIRES_NEW_SIGNAL', payload: { wallet: walletAddress, signature, signalAt, lastClose } });
      this._persist();
      return { status: 'expired', reason: 'reentry-cooldown' };
    }
    let candidate = this.state.candidates.find((item) => item.mint === mint && ['OBSERVED', 'EVALUATING', 'WAITING_FOR_ROUTE'].includes(item.status));
    if (!candidate) {
      candidate = {
        id: this._id('candidate'), mint, symbol: String(signal.symbol || ''), name: String(signal.name || ''), lifecycleStage: String(signal.lifecycleStage || 'UNKNOWN'),
        createdAt: this.clock(), firstSignalAt: signalAt, lastSignalAt: signalAt, status: 'OBSERVED',
        sourceWallets: [], sourceSignatures: [], signalTiming: {}, riskFlags: signal.riskFlags || {}, security: signal.security || {}
      };
      boundedPush(this.state.candidates, candidate, this.config.bot.refined.maxRecentCandidates);
      this.state.performance.candidates += 1;
    }
    if (!candidate.sourceWallets.some((item) => item.address === walletAddress)) candidate.sourceWallets.push({ address: walletAddress, label: wallet.label, weight: wallet.weight, at: signalAt });
    if (signature && !candidate.sourceSignatures.includes(signature)) candidate.sourceSignatures.push(signature);
    candidate.lastSignalAt = Math.max(candidate.lastSignalAt, signalAt);
    candidate.signalTiming = {
      notificationAt: signal.notificationAt || null, transactionFetchedAt: signal.transactionFetchedAt || null,
      classificationAt: signal.classificationAt || null, detectionLatencyMs: signal.detectionLatencyMs || null
    };
    this._event('CANDIDATE_OBSERVED', { mint, side, status: 'OBSERVED', payload: { candidateId: candidate.id, wallet: walletAddress, signature, signalAgeMs } });
    if (!this.state.autoRun) {
      candidate.status = 'EXPIRED'; candidate.reason = 'AUTOMATION_PAUSED'; candidate.completedAt = this.clock();
      this._event('CANDIDATE_EXPIRED', { mint, side, status: candidate.status, reason: candidate.reason, payload: { candidateId: candidate.id } });
    }
    this._persist();
    if (!this.state.autoRun) return { status: 'expired', candidateId: candidate.id, state: 'EXPIRED', reason: 'automation-paused' };
    return this._attemptEntry(candidate);
  }

  _candidateAgeMs(candidate) { return Math.max(0, this.clock() - Number(candidate.lastSignalAt || candidate.createdAt || this.clock())); }

  _clearRetry(mint) {
    const timer = this.retryTimers.get(mint);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(mint);
  }

  _expireCandidate(candidate, reason = 'SIGNAL_OLDER_THAN_OPPORTUNITY_WINDOW') {
    this._clearRetry(candidate.mint);
    candidate.status = 'EXPIRED'; candidate.reason = reason; candidate.completedAt = this.clock();
    if (/SIGNAL/.test(reason)) this.state.parity.staleSignalDrops += 1;
    this._event('CANDIDATE_EXPIRED', { mint: candidate.mint, side: 'BUY', status: candidate.status, reason, payload: { candidateId: candidate.id, signalAgeMs: this._candidateAgeMs(candidate) } });
    this._persist();
    return { status: 'expired', reason, candidateId: candidate.id };
  }

  _deferCandidate(candidate, reason) {
    const opportunityWindowMs = this.config.bot.refined.opportunityWindowMs;
    if (this._candidateAgeMs(candidate) > opportunityWindowMs) return this._expireCandidate(candidate);
    if (reason === 'RATE_LIMITED') this.state.performance.rateLimits += 1;
    candidate.status = 'WAITING_FOR_ROUTE'; candidate.reason = reason;
    this._event('CANDIDATE_WAITING_FOR_ROUTE', { mint: candidate.mint, side: 'BUY', status: candidate.status, reason, payload: { candidateId: candidate.id } });
    this._persist();
    if (!this.retryTimers.has(candidate.mint) && this.state.autoRun) {
      const remaining = Math.max(1, opportunityWindowMs - this._candidateAgeMs(candidate));
      const timer = setTimeout(() => {
        this.retryTimers.delete(candidate.mint);
        if (this.state.autoRun && candidate.status === 'WAITING_FOR_ROUTE') void this._attemptEntry(candidate);
      }, Math.min(this.config.bot.paperAggressive.priceRetryMs, remaining));
      timer.unref?.();
      this.retryTimers.set(candidate.mint, timer);
    }
    return { status: 'waiting', reason, candidateId: candidate.id, state: candidate.status };
  }

  // FlowDeck Lite: one authoritative decision. `risk.rejectReason` (executable buy/sell economics
  // vs. the configured stop/loss limits) and `securityResult` (rug/blacklist/mint-authority) are
  // the only hard gates on a structurally sound trade. The Bayesian brain and trajectory outputs
  // are still computed and recorded on every candidate/trade (see BRAIN_CONTROL_DIVERGENCE and
  // intent.mathematics) for later evidence, but do not veto - with near-zero real closed-trade
  // history their prior-driven estimate isn't validated enough to override a route that already
  // cleared execution and risk. Flip respectBrainHardGate once BRAIN_CONTROL_DIVERGENCE shows the
  // veto is actually predictive.
  _classify(candidate, assessment, brain, risk, enrichment = {}, securityResult = null) {
    if (!assessment?.ok || risk?.rejectReason || candidate.riskFlags?.critical || candidate.security?.honeypot || securityResult?.result === 'REJECT') return 'AVOID';
    if (this.config.bot.brain.respectBrainHardGate && brain?.action === 'OBSERVE') return 'AVOID';
    if (this.state.mode === 'BOT_LIVE' && securityResult?.result !== 'PASSED_FIRST_FILTER') return 'AVOID';
    if (securityResult?.result === 'NEEDS_DEEPER_RESEARCH') return 'EXPERIMENTAL';
    const cutoff = this.clock() - this.config.bot.refined.consensusWindowSeconds * 1000;
    const voters = candidate.sourceWallets.filter((wallet) => Number(wallet.at || candidate.createdAt) >= cutoff).length;
    if (voters >= this.config.bot.strong.walletCount) return 'STRONG';
    // X/social is a bonus signal only: it can nudge an otherwise-EXPERIMENTAL candidate up to
    // NORMAL confidence, same as light wallet consensus or positive momentum would, but it never
    // appears above (in the AVOID/security/risk gates) and so can never block or override them.
    const market = enrichment.market || {};
    const socialSignal = Boolean(market.hasSocial) || Number(market.socialViews) >= 200 || Number(market.socialComments) >= 10;
    if (voters >= 2 || Number(brain?.expectedNetSol) >= 0 || Number(enrichment.momentumPct) > 0 || socialSignal) return 'NORMAL';
    return 'EXPERIMENTAL';
  }

  _recordExecutableQuote(mint, tokenAmountAtomic, outputLamports, at = this.clock()) {
    const token = safeAtomic(tokenAmountAtomic);
    const output = safeAtomic(outputLamports);
    if (token <= 0n || output <= 0n) return;
    const price = Number(output) / Number(token);
    if (!(price > 0) || !Number.isFinite(price)) return;
    const series = this.quoteSeries.get(mint) || [];
    boundedPush(series, { at, price }, 120);
    this.quoteSeries.set(mint, series);
    if (this.quoteSeries.size > this.config.bot.refined.maxRecentCandidates) {
      const protectedMints = new Set(this.getActiveMints());
      for (const key of this.quoteSeries.keys()) {
        if (!protectedMints.has(key)) this.quoteSeries.delete(key);
        if (this.quoteSeries.size <= this.config.bot.refined.maxRecentCandidates) break;
      }
    }
  }

  _quoteVolatility(mint) {
    const prices = (this.quoteSeries.get(mint) || []).map((item) => item.price);
    return volatilityPct({ returnsPct: percentReturns(prices) });
  }

  _researchFallback(candidate, reason = 'GMGN_UNAVAILABLE') {
    return {
      mint: candidate.mint,
      identity: { mint: candidate.mint, name: candidate.name || 'Unknown token', symbol: candidate.symbol || 'Unknown token', source: candidate.name || candidate.symbol ? 'SIGNAL' : 'FALLBACK' },
      info: null, security: null, pool: null, candles: [], unavailable: true, unavailableReasons: [reason], observedAt: this.clock(),
      filter: { result: 'NEEDS_DEEPER_RESEARCH', reason: 'INCOMPLETE_GMGN_EVIDENCE', flags: ['INCOMPLETE_GMGN_EVIDENCE'] }
    };
  }

  _securityResult(research, reverseRouteAvailable) {
    if (this.researchProvider?.classify) return this.researchProvider.classify(research, { reverseRouteAvailable });
    if (!reverseRouteAvailable) return { result: 'REJECT', reason: 'NO_EXACT_REVERSE_SELL_ROUTE', flags: ['NO_REVERSE_ROUTE'] };
    return research?.filter || { result: 'NEEDS_DEEPER_RESEARCH', reason: 'INCOMPLETE_GMGN_EVIDENCE', flags: ['INCOMPLETE_GMGN_EVIDENCE'] };
  }

  _enrichment(candidate, research) {
    const gmgnCandles = Array.isArray(research?.candles) ? research.candles : [];
    const referenceSeries = gmgnCandles.length
      ? gmgnCandles.map((item) => ({ at: Number(item.time), price: Number(item.close), volume: Number(item.volume || 0) })).filter((item) => item.price > 0)
      : (this.marketSeries.get(candidate.mint) || []);
    const firstPrice = Number(referenceSeries.at(-5)?.price || referenceSeries[0]?.price);
    const lastPrice = Number(referenceSeries.at(-1)?.price);
    const momentumPct = firstPrice > 0 && lastPrice > 0 ? (lastPrice / firstPrice - 1) * 100 : null;
    const trajectory = this.trajectoryIndex?.match?.(referenceSeries.map((item) => ({ time: item.at, close: item.price, volume: item.volume }))) || { label: 'unavailable', confidence: 0 };
    return { quoteVolatility: this._quoteVolatility(candidate.mint), momentumPct, trajectory, market: this.markets.get(candidate.mint) || null };
  }

  async _resolveSizing() {
    if (!this.jupiterClient?.quoteSolUsd) return { ok: false, reason: 'SOL_USD_UNAVAILABLE' };
    const solUsd = await this.jupiterClient.quoteSolUsd({ fresh: false });
    const ageMs = solUsd?.observedAt ? Math.max(0, this.clock() - Number(solUsd.observedAt)) : Infinity;
    if (!solUsd?.ok || !(Number(solUsd.price) > 0) || ageMs > this.config.jupiter.solUsdRefreshMs) return { ok: false, reason: 'SOL_USD_UNAVAILABLE', solUsd };
    const inputLamports = this.config.useFixedTradeSizeSol
      ? decimalToAtomic(this.config.fixedTradeSizeSol, 9)
      : entryLamportsForUsd(this.config.tradeSizeUsd, solUsd.price);
    if (inputLamports <= 0n) return { ok: false, reason: 'INVALID_DYNAMIC_SIZE', solUsd };
    return {
      ok: true, mode: this.config.useFixedTradeSizeSol ? 'FIXED_SOL' : 'USD_TARGET', targetUsd: this.config.tradeSizeUsd,
      fixedTradeSizeSol: this.config.fixedTradeSizeSol, inputLamports: inputLamports.toString(), submittedSol: atomicToDecimalString(inputLamports, 9),
      estimatedUsdMicros: usdMicrosFromLamports(inputLamports, solUsd.price).toString(), solUsd: String(solUsd.price),
      solUsdObservedAt: solUsd.observedAt, solUsdAgeMs: ageMs, solUsdSource: solUsd.source
    };
  }

  _plannedDelay() {
    const settings = this.config.bot.refined;
    const observed = this.state.latency.signalToBuildMs.slice(-200);
    const estimate = observed.length >= 5 ? percentile(observed, 0.75) : settings.executionDelayDefaultMs;
    return Math.trunc(clamp(Number(estimate), settings.executionDelayMinMs, settings.executionDelayMaxMs));
  }

  _feeEstimate(quote) {
    const baseFallback = decimalToAtomic(this.config.paper.networkFeeSol, 9);
    const priorityFallback = decimalToAtomic(this.config.paper.priorityFeeSol, 9);
    const signature = safeAtomic(quote?.signatureFeeLamports);
    const priority = safeAtomic(quote?.prioritizationFeeLamports);
    const rent = safeAtomic(quote?.rentFeeLamports);
    return {
      networkFeeLamports: (signature > 0n ? signature : baseFallback).toString(),
      priorityFeeLamports: (priority > 0n ? priority : priorityFallback).toString(),
      rentFeeLamports: rent.toString(),
      networkFeeEvidence: signature > 0n ? 'ROUTE_REPORTED' : 'MODELLED',
      priorityFeeEvidence: priority > 0n ? 'ROUTE_REPORTED' : 'MODELLED',
      rentFeeEvidence: quote?.rentFeeLamports != null ? 'ROUTE_REPORTED' : 'MODELLED',
      platformFeeAmountAtomic: String(quote?.platformFeeAmountAtomic || ''),
      platformFeeMint: String(quote?.feeMint || ''),
      platformFeeEvidence: quote?.platformFeeAmountAtomic ? 'ROUTE_REPORTED' : 'MODELLED_IN_ROUTE_OUTPUT',
      evidence: quote?.feeAccountingComplete ? 'ROUTE_REPORTED' : 'MODELLED',
      complete: Boolean(quote?.feeAccountingComplete),
      totalLamports: ((signature > 0n ? signature : baseFallback) + (priority > 0n ? priority : priorityFallback) + rent).toString()
    };
  }

  _regime(candidate) {
    const market = this.markets.get(candidate.mint);
    return { lifecycleStage: candidate.lifecycleStage, liquidityBand: liquidityBand(market?.liquidityUsd), ageBand: 'EARLY' };
  }

  _proofWindow(regime) {
    const settings = this.config.bot.refined;
    const samples = this.state.closedTrades.filter((trade) => trade.executable !== false && Number.isFinite(Number(trade.timeToPositiveMs))
      && (!regime.lifecycleStage || trade.lifecycleStage === regime.lifecycleStage)
      && (!regime.liquidityBand || trade.liquidityBand === regime.liquidityBand))
      .map((trade) => Number(trade.timeToPositiveMs));
    const estimate = samples.length >= 3 ? percentile(samples, 0.75) : settings.proofWindowDefaultMs;
    return Math.trunc(clamp(estimate, settings.proofWindowMinMs, settings.proofWindowMaxMs));
  }

  async _withLock(mint, operation) {
    if (this.locks.has(mint)) return { status: 'duplicate', reason: 'mint-operation-in-flight' };
    this.locks.add(mint);
    try { return await operation(); } finally { this.locks.delete(mint); }
  }

  async _attemptEntry(candidate) {
    return this._withLock(candidate.mint, async () => {
      try { return await this._attemptEntryLocked(candidate); }
      catch (error) {
        const intent = [...this.state.intents].reverse().find((item) => item.candidateId === candidate.id && IN_FLIGHT.has(item.status));
        const reason = `INTERNAL_EXECUTION_ERROR:${String(error.message || error).slice(0, 180)}`;
        return intent ? this._noFill(intent, candidate, reason) : this._rejectCandidate(candidate, reason);
      }
    });
  }

  async _attemptEntryLocked(candidate) {
      if (!this.state.autoRun) return this._expireCandidate(candidate, 'AUTOMATION_PAUSED');
      if (this._candidateAgeMs(candidate) > this.config.bot.refined.opportunityWindowMs) return this._expireCandidate(candidate);
      if (!this.jupiterClient) return this._deferCandidate(candidate, 'JUPITER_UNAVAILABLE');
      if (this.state.positions.some((position) => position.mint === candidate.mint)) return { status: 'duplicate', reason: 'position-already-open' };
      if (this.state.positions.length >= this.config.bot.paperAggressive.maxOpenPositions) return this._rejectCandidate(candidate, 'POSITION_CAPACITY');
      candidate.status = 'EVALUATING'; candidate.reason = null;
      this._event('CANDIDATE_EVALUATING', { mint: candidate.mint, side: 'BUY', status: candidate.status, payload: { candidateId: candidate.id } });
      const researchPromise = this.researchProvider?.inspectMint
        ? this.researchProvider.inspectMint(candidate.mint).catch((error) => this._researchFallback(candidate, String(error.code || error.message || 'GMGN_UNAVAILABLE')))
        : Promise.resolve(this._researchFallback(candidate));
      const sizing = await this._resolveSizing().catch(() => ({ ok: false, reason: 'SOL_USD_UNAVAILABLE' }));
      if (!sizing.ok) return this._deferCandidate(candidate, sizing.reason);
      const inputLamports = atomic(sizing.inputLamports);
      const decisionAt = this.clock();
      boundedPush(this.state.latency.signalToDecisionMs, Math.max(0, decisionAt - Number(candidate.lastSignalAt || decisionAt)), 2000);
      this.state.parity.routeAttempts += 1;
      const assessmentPromise = this.jupiterClient.prepareEntry({ outputMint: candidate.mint, inputLamports: inputLamports.toString(), fresh: true });
      const [assessment, research] = await Promise.all([assessmentPromise, researchPromise]);
      const firstQuoteAt = this.clock();
      boundedPush(this.state.latency.signalToBuildMs, Math.max(0, firstQuoteAt - decisionAt), 2000);
      // Feeds the mint's price series used by _quoteVolatility() -> dynamicStop()'s noisePct.
      // Recording the conservative/floor value here (instead of the modelled price) injected
      // Jupiter's own protective-buffer noise into the series as if it were real price movement,
      // producing multi-hundred-percent "volatility" estimates that dominated rawStopPct even
      // when the token's real price impact was small.
      if (assessment?.reverse?.ok) this._recordExecutableQuote(candidate.mint, assessment.modelledTokenAtomic, modelledFillOutput(assessment.reverse, this.config.paper.realisticSlippageBps).atomic, assessment.reverse.receivedAt);
      const identity = research?.identity || this._researchFallback(candidate).identity;
      candidate.symbol = identity.symbol; candidate.name = identity.name; candidate.identity = identity;
      candidate.securityResult = this._securityResult(research, Boolean(assessment?.reverse?.ok));
      candidate.research = {
        observedAt: research?.observedAt || null, filter: candidate.securityResult, unavailable: Boolean(research?.unavailable),
        liquidityUsd: Number(research?.pool?.liquidity ?? research?.info?.liquidity ?? research?.info?.pool?.liquidity) || null,
        smartMoney: Number(research?.info?.wallet_tags_stat?.smart_wallets || 0), kol: Number(research?.info?.wallet_tags_stat?.renowned_wallets || 0)
      };
      if (this._candidateAgeMs(candidate) > this.config.bot.refined.opportunityWindowMs) return this._expireCandidate(candidate);
      if (!assessment?.ok) {
        if (['RATE_LIMITED', 'QUOTE_EXPIRED', 'PROVIDER_UNAVAILABLE'].includes(assessment?.outcome)) return this._deferCandidate(candidate, assessment.outcome);
        return this._rejectCandidate(candidate, assessment?.outcome || 'NO_ROUTE');
      }
      if (candidate.securityResult.result === 'REJECT') return this._rejectCandidate(candidate, candidate.securityResult.reason);
      this.state.parity.exactRoutes += 1;
      if (assessment.entry.transactionPresent) this.state.parity.buildable += 1;
      const enrichment = this._enrichment(candidate, research);
      const entryFees = this._feeEstimate(assessment.entry);
      const exitFees = this._feeEstimate(assessment.reverse);
      // Friction must be estimated on the same modelled basis as the fill/mark (Fix 1/2), not
      // Jupiter's own protection-floor otherAmountThreshold - that floor carries Jupiter's own
      // slippage buffer (observed ~20%), which stacked on top of real price impact inflated the
      // required stop past maxStopPct for most candidates regardless of actual token risk.
      let risk = dynamicStop({
        config: this.config, inputLamports, immediateReverseLamports: modelledFillOutput(assessment.reverse, this.config.paper.realisticSlippageBps).atomic,
        entryFeeLamports: entryFees.totalLamports, exitFeeLamports: exitFees.totalLamports,
        volatility: enrichment.quoteVolatility, closedTrades: this.state.closedTrades, regime: this._regime(candidate)
      });
      const brainCandidate = { ...candidate, plannedInputLamports: inputLamports.toString(), sourceWallets: candidate.sourceWallets };
      const brain = evaluateBrain({ candidate: brainCandidate, assessment, closedPositions: this.state.closedTrades, config: this.config, decisionAt });
      if (brain.action !== brain.controlAction) {
        this._event('BRAIN_CONTROL_DIVERGENCE', { mint: candidate.mint, side: 'BUY', status: 'OBSERVED', reason: brain.hardGate, payload: { candidateId: candidate.id, brainAction: brain.action, controlAction: brain.controlAction, hardGate: brain.hardGate, respectBrainHardGate: this.config.bot.brain.respectBrainHardGate } });
      }
      const classification = this._classify(candidate, assessment, brain, risk, enrichment, candidate.securityResult);
      const decisionId = this._id('decision');
      const frozen = immutableSnapshot({
        decision_id: decisionId, candidate_id: candidate.id, mint: candidate.mint, token_identity: identity,
        signal_at: candidate.lastSignalAt, signal_age_ms: this._candidateAgeMs(candidate), source_wallets: candidate.sourceWallets,
        source_signatures: candidate.sourceSignatures, sizing, security_result: candidate.securityResult,
        brain, momentum_pct: enrichment.momentumPct, trajectory: enrichment.trajectory, stop_model: risk,
        entry_quote: sanitizeQuote(assessment.entry), reverse_quote: sanitizeQuote(assessment.reverse), classification
      });
      const intent = {
        decisionId, sessionId: this.state.session.id, candidateId: candidate.id, mint: candidate.mint, symbol: identity.symbol, name: identity.name, tokenIdentity: identity, side: 'BUY',
        inputMint: SOL_MINT, outputMint: candidate.mint, inputAmountAtomic: inputLamports.toString(),
        walletEvidence: { wallets: candidate.sourceWallets, signatures: candidate.sourceSignatures }, decisionTimestamp: decisionAt,
        sizing, securityResult: candidate.securityResult, snapshot: frozen,
        initialQuote: sanitizeQuote(assessment.entry), minimumOutputAtomic: minimumOutput(assessment.entry, this.config.paper.slippageBps), route: assessment.entry.routePlan || [], priceImpactPct: assessment.entry.priceImpactPct ?? null, plannedExecutionDelayMs: this._plannedDelay(),
        stopModel: risk, tp1Policy: { triggerNetPnlPct: 15, sellPct: 50 }, runnerPolicy: { trailPct: runnerTrailPct({ sigmaPct: risk.volatilitySigmaPct, friction: risk.frictionPct, minimum: this.config.bot.refined.runnerTrailMinPct, maximum: this.config.bot.refined.runnerTrailMaxPct, multiplier: this.config.bot.refined.runnerTrailSigmaMultiplier }), maximumHoldMinutes: this.config.bot.exit.maxTotalHoldMinutes },
        mathematics: { brain, trajectory: enrichment.trajectory, quoteVolatilityPct: enrichment.quoteVolatility, momentumPct: enrichment.momentumPct, regime: this._regime(candidate), market: enrichment.market },
        classification, mode: this.state.mode, status: 'SIMULATING', fillQuality: null, reason: null, simulation: null, revalidation: null,
        timings: { decisionToFirstQuoteMs: firstQuoteAt - decisionAt }, discoverySource: candidate.discoverySource || null
      };
      boundedPush(this.state.intents, intent, this.config.bot.refined.maxIntents);
      this._event('EXECUTION_INTENT_FROZEN', { decisionId: intent.decisionId, mint: intent.mint, side: 'BUY', status: intent.status, payload: { candidateId: candidate.id, snapshotId: frozen.snapshot_id, classification } });
      this._persist();
      if (intent.classification === 'AVOID') return this._noFill(intent, candidate, risk.rejectReason || brain.hardGate || 'AVOID');
      const requiredBalance = inputLamports + atomic(entryFees.totalLamports);
      if (atomic(this.state.session.balanceLamports) < requiredBalance) return this._noFill(intent, candidate, 'INSUFFICIENT_PAPER_BALANCE');
      intent.status = 'SIMULATING';
      const simulation = await this._simulate(assessment.entry);
      intent.simulation = simulation;
      if (simulation.attempted) this.state.parity.simulationAttempts += 1;
      if (simulation.classification === 'ACCEPTABLE') this.state.parity.simulationAccepted += 1;
      if (simulation.classification === 'DETERMINISTIC_ERROR') return this._noFill(intent, candidate, 'DETERMINISTIC_SIMULATION_ERROR');
      intent.status = 'WAITING_LANDING';
      await this.wait(intent.plannedExecutionDelayMs);
      if (this._candidateAgeMs(candidate) > this.config.bot.refined.opportunityWindowMs) return this._noFill(intent, candidate, 'SIGNAL_EXPIRED_BEFORE_FILL');
      intent.status = 'REVALIDATING';
      this.state.parity.revalidations += 1;
      const revalidated = await this.jupiterClient.prepareEntry({ outputMint: candidate.mint, inputLamports: inputLamports.toString(), fresh: true });
      intent.revalidation = { outcome: revalidated.outcome, entry: sanitizeQuote(revalidated.entry), reverse: sanitizeQuote(revalidated.reverse), at: this.clock() };
      if (!revalidated.ok) return this._noFill(intent, candidate, revalidated.outcome || 'REVALIDATION_NO_ROUTE');
      this._recordExecutableQuote(candidate.mint, revalidated.modelledTokenAtomic, modelledFillOutput(revalidated.reverse, this.config.paper.realisticSlippageBps).atomic, revalidated.reverse.receivedAt);
      const quoteAge = this.clock() - Number(revalidated.entry.receivedAt || 0);
      boundedPush(this.state.latency.quoteAgeMs, quoteAge, 2000);
      if (quoteAge > this.config.jupiter.quoteMaxAgeMs) return this._noFill(intent, candidate, 'STALE_QUOTE');
      const modelledEntry = modelledFillOutput(revalidated.entry, this.config.paper.realisticSlippageBps);
      if (atomic(modelledEntry.atomic) < atomic(intent.minimumOutputAtomic)) return this._noFill(intent, candidate, 'WOULD_FAIL_SLIPPAGE');
      this.state.parity.revalidationSuccesses += 1;
      const finalEntryFees = this._feeEstimate(revalidated.entry);
      const finalExitFees = this._feeEstimate(revalidated.reverse);
      risk = dynamicStop({
        config: this.config, inputLamports, immediateReverseLamports: modelledFillOutput(revalidated.reverse, this.config.paper.realisticSlippageBps).atomic,
        entryFeeLamports: finalEntryFees.totalLamports, exitFeeLamports: finalExitFees.totalLamports,
        volatility: this._quoteVolatility(candidate.mint), closedTrades: this.state.closedTrades, regime: this._regime(candidate)
      });
      intent.stopModel = risk;
      if (risk.rejectReason) return this._noFill(intent, candidate, risk.rejectReason);
      if (this._candidateAgeMs(candidate) > this.config.bot.refined.opportunityWindowMs) return this._noFill(intent, candidate, 'SIGNAL_EXPIRED_BEFORE_FILL');
      intent.status = 'EXECUTING';
      return this._finalizeIntent({ intent, candidate, assessment: revalidated, fees: finalEntryFees, simulation, modelledEntry });
  }

  async _simulate(quote) {
    if (!quote?.transaction) return { attempted: false, classification: 'PAPER_STATE_ONLY', reason: 'NO_PAPER_TAKER_TRANSACTION' };
    if (!this.simulator) return { attempted: false, classification: 'PAPER_STATE_ONLY', reason: 'SIMULATOR_UNAVAILABLE' };
    try {
      const result = await this.simulator({ transaction: quote.transaction, quote });
      if (result?.classification) return { attempted: true, ...result };
      return result?.ok ? { attempted: true, classification: 'ACCEPTABLE', details: result } : { attempted: true, classification: 'DETERMINISTIC_ERROR', details: result };
    } catch (error) {
      return { attempted: true, classification: 'DETERMINISTIC_ERROR', reason: String(error.message || error).slice(0, 300) };
    }
  }

  _noFill(intent, candidate, reason) {
    intent.status = 'NO_FILL'; intent.fillQuality = FILL_QUALITY.NO_FILL; intent.reason = reason; intent.completedAt = this.clock();
    this.state.parity.fillQualities.NO_FILL += 1;
    this._event('INTENT_NO_FILL', { decisionId: intent.decisionId, mint: intent.mint, side: intent.side, status: intent.status, reason, payload: { fillQuality: intent.fillQuality, intent } });
    if (/SIGNAL_EXPIRED/.test(reason)) {
      candidate.status = 'EXPIRED'; candidate.reason = reason; candidate.completedAt = this.clock(); this.state.parity.staleSignalDrops += 1;
    } else {
      candidate.status = 'REJECTED'; candidate.reason = reason; candidate.completedAt = this.clock();
    }
    this._persist();
    if (['RATE_LIMITED', 'QUOTE_EXPIRED', 'PROVIDER_UNAVAILABLE'].includes(reason) && this._candidateAgeMs(candidate) <= this.config.bot.refined.opportunityWindowMs) return this._deferCandidate(candidate, reason);
    return { status: 'no-fill', reason, decisionId: intent.decisionId, fillQuality: FILL_QUALITY.NO_FILL };
  }

  _rejectCandidate(candidate, reason) {
    this._clearRetry(candidate.mint);
    candidate.status = 'REJECTED'; candidate.reason = reason; candidate.completedAt = this.clock();
    this.state.parity.fillQualities.NO_FILL += 1;
    this._event('CANDIDATE_REJECTED', { mint: candidate.mint, side: 'BUY', status: candidate.status, reason }); this._persist();
    return { status: 'no-fill', reason, fillQuality: FILL_QUALITY.NO_FILL };
  }

  _fillQuality(quote, simulation, fees) {
    if (quote?.transactionPresent && simulation?.classification === 'ACCEPTABLE') return FILL_QUALITY.SIMULATED_BUILDABLE;
    if (quote?.transactionPresent) return FILL_QUALITY.BUILDABLE_UNSIMULATED;
    return FILL_QUALITY.QUOTE_PARITY;
  }

  _finalizeIntent({ intent, candidate, assessment, fees, simulation, modelledEntry }) {
    if (intent.mode !== 'BOT_PAPER') return this._noFill(intent, candidate, 'LIVE_EXECUTION_ADAPTER_NOT_INSTALLED');
    const input = atomic(intent.inputAmountAtomic);
    const fee = atomic(fees.totalLamports);
    const balance = atomic(this.state.session.balanceLamports);
    if (balance < input + fee) return this._noFill(intent, candidate, 'INSUFFICIENT_PAPER_BALANCE');
    const modelled = modelledEntry || modelledFillOutput(assessment.entry, this.config.paper.realisticSlippageBps);
    const at = this.clock();
    const fillQuality = this._fillQuality(assessment.entry, simulation, fees);
    const fill = {
      id: this._id('fill'), decisionId: intent.decisionId, positionId: null, at, side: 'BUY', fillQuality,
      inputMint: SOL_MINT, outputMint: intent.mint, inputAmountAtomic: input.toString(), outputAmountAtomic: modelled.atomic,
      expectedOutputAmountAtomic: assessment.quotedTokenAtomic, conservativeOutputAmountAtomic: assessment.conservativeTokenAtomic,
      modelledFillOutputAtomic: modelled.atomic, modelledSlippageBps: modelled.slippageBps,
      minimumOutputAtomic: intent.minimumOutputAtomic, requestId: assessment.entry.requestId, router: assessment.entry.router,
      fees, simulation, sizing: intent.sizing, tokenIdentity: intent.tokenIdentity, revalidatedQuote: sanitizeQuote(assessment.entry)
    };
    // Fix 2 regression guard: the just-opened position's unrealised mark, on the same
    // modelled basis used for the fill, must be within the risk budget dynamicStop() already
    // approved for this candidate (assessment.reverse here is the exact same revalidated quote
    // dynamicStop priced its stopPct against, so the two should track closely). A universal
    // 1.5% constant was rejecting completely legitimate meme friction that the risk model had
    // already cleared up to stopPct/maxStopPct; this now only fires on genuine basis drift
    // between what risk approved and what the fill actually opens at.
    const modelledReverse = modelledFillOutput(assessment.reverse, this.config.paper.realisticSlippageBps);
    const openingExitFee = atomic(this._feeEstimate(assessment.reverse).totalLamports);
    const openingUnrealizedLamports = atomic(modelledReverse.atomic) - openingExitFee - input - fee;
    const openingUnrealizedPct = input > 0n ? Number(openingUnrealizedLamports * 1_000_000n / input) / 10_000 : 0;
    const approvedBasisBudgetPct = Number.isFinite(Number(intent.stopModel?.stopPct)) ? Number(intent.stopModel.stopPct) : 1.5;
    if (Math.abs(openingUnrealizedPct) > approvedBasisBudgetPct) {
      throw Object.assign(new Error(`POSITION_OPENED_OFF_BASIS: opening unrealised ${openingUnrealizedPct.toFixed(2)}% exceeds the approved ${approvedBasisBudgetPct.toFixed(2)}% risk budget`), { code: 'POSITION_OPENED_OFF_BASIS', openingUnrealizedPct });
    }
    const regime = intent.mathematics.regime;
    const position = {
      id: this._id('position'), decisionId: intent.decisionId, mint: intent.mint, symbol: intent.symbol, name: intent.name, tokenIdentity: intent.tokenIdentity,
      status: 'OPEN', stage: 'BEFORE_TP1', entryAt: at, inputLamports: input.toString(), entryFeesLamports: fee.toString(),
      initialTokenAmountAtomic: modelled.atomic, remainingTokenAmountAtomic: modelled.atomic,
      tokenDecimals: assessment.tokenDecimals, grossExitProceedsLamports: '0', grossExitProceedsConservativeLamports: '0', exitFeesLamports: '0', realizedPnlLamports: '0',
      remainingEntrySpendLamports: input.toString(), remainingEntryFeesLamports: fee.toString(),
      fillQuality, entryFillId: fill.id, sourceWallets: candidate.sourceWallets, sourceSignatures: candidate.sourceSignatures, discoverySource: intent.discoverySource || null,
      sizing: intent.sizing, securityResult: intent.securityResult, classification: intent.classification, decisionSnapshot: intent.snapshot,
      lifecycleStage: candidate.lifecycleStage, liquidityBand: regime.liquidityBand, liquidityUsdAtEntry: Number(intent.mathematics?.market?.liquidityUsd || this.markets.get(candidate.mint)?.liquidityUsd) || null,
      frozenStopPct: intent.stopModel.stopPct, currentStopPct: intent.stopModel.stopPct, stopPnlFloorPct: -intent.stopModel.stopPct,
      stopModel: intent.stopModel, stopChanges: [], tp1: { hit: false, fillId: null, at: null }, runnerPolicy: intent.runnerPolicy,
      proofWindowMs: this._proofWindow(regime), firstPositiveAt: null, timeToPositiveMs: null, mfePct: 0, maePct: 0, maeBeforeTp1Pct: 0, lastExecutablePnlPct: null,
      consecutiveDeteriorations: 0, sellRetryCount: 0, nextSellRetryAt: 0, exitAttempts: [], lastQuote: sanitizeQuote(assessment.reverse),
      lastConservativeLiquidationLamports: minimumOutput(assessment.reverse, this.config.paper.slippageBps),
      lastModelledLiquidationLamports: modelledReverse.atomic,
      stopTrigger: null, stopOvershootPct: null, markCount: 0, stopArmedAt: null,
      profitLockArmed: false, profitLockFloorPct: null
    };
    fill.positionId = position.id;
    this.state.session.balanceLamports = (balance - input - fee).toString();
    boundedPush(this.state.fills, fill, this.config.bot.refined.maxFills);
    this.state.positions.push(position);
    intent.status = 'FILLED'; intent.fillQuality = fillQuality; intent.fillId = fill.id; intent.positionId = position.id; intent.completedAt = at;
    candidate.status = 'BOUGHT'; candidate.positionId = position.id; candidate.completedAt = at;
    this._clearRetry(candidate.mint);
    this.state.parity.fillQualities[fillQuality] += 1;
    this.state.performance.paperFills += 1;
    if (fees.complete) this.state.parity.feeComplete += 1;
    boundedPush(this.state.latency.signalToFillMs, Math.max(0, at - Number(candidate.lastSignalAt || at)), 2000);
    boundedPush(this.state.latency.decisionToFillMs, Math.max(0, at - Number(intent.decisionTimestamp || at)), 2000);
    this._event('POSITION_OPENED', { decisionId: intent.decisionId, positionId: position.id, mint: intent.mint, side: 'BUY', status: 'OPEN', payload: { fillId: fill.id, fillQuality, stopPct: intent.stopModel.stopPct } });
    this._persist();
    return { status: 'filled', decisionId: intent.decisionId, positionId: position.id, fillQuality, fill };
  }

  setMarket(input = {}) {
    const mint = String(input.mint || '').trim();
    if (!mint) return { status: 'ignored', reason: 'mint-required' };
    const at = Number(input.observedAt || this.clock());
    const market = { ...(this.markets.get(mint) || {}), ...input, mint, receivedAt: this.clock(), observedAt: at };
    this.markets.set(mint, market);
    if (this.markets.size > 200) {
      const protectedMints = new Set(this.getActiveMints());
      for (const key of this.markets.keys()) {
        if (!protectedMints.has(key)) { this.markets.delete(key); this.marketSeries.delete(key); }
        if (this.markets.size <= 150) break;
      }
    }
    const price = Number(input.priceSol || input.priceUsd || input.marketCapUsd);
    if (price > 0) boundedPush(this.marketSeries.get(mint) || (this.marketSeries.set(mint, []), this.marketSeries.get(mint)), { at, price, volume: Number(input.volume || input.volume24h || 0) }, 120);
    if (this.state.positions.some((position) => position.mint === mint)) void this._evaluatePosition(mint);
    else void this._maybeDiscoverCandidate(mint, market, at);
    return { status: 'updated', market };
  }

  // "Interesting enough to observe", not "buy" - a qualifying tier still goes through the exact
  // same fresh/security/executable/risk pipeline as a wallet signal via _attemptEntry. Returns
  // null (not a rejection, just "not yet interesting") whenever a required field isn't present,
  // so incomplete market data can never be misread as passing a tier.
  _classifyDiscoveryTier(market) {
    const cfg = this.config.bot.discovery;
    if (!cfg?.enabled) return null;
    const marketCapUsd = Number(market.marketCapUsd);
    const volumeUsd = Number(market.volumeUsd ?? market.volume24hUsd ?? market.volume);
    const feesSol = Number(market.feesSol);
    const ageMinutes = Number(market.ageMinutes ?? (Number.isFinite(Number(market.createdAt)) ? (this.clock() - Number(market.createdAt)) / 60_000 : NaN));
    const hasSocial = Boolean(market.hasSocial || Number(market.socialViews) >= 200 || Number(market.socialComments) >= 10);
    const b = cfg.brandNew;
    if (Number.isFinite(marketCapUsd) && marketCapUsd >= b.minMarketCapUsd && marketCapUsd <= b.maxMarketCapUsd
      && Number.isFinite(volumeUsd) && volumeUsd >= b.minVolumeUsd && Number.isFinite(feesSol) && feesSol >= b.minFeesSol
      && (!b.requireSocial || hasSocial)) return 'BRAND_NEW';
    const s = cfg.soonMigrated;
    if (Number.isFinite(marketCapUsd) && marketCapUsd >= s.minMarketCapUsd && Number.isFinite(ageMinutes) && ageMinutes <= s.maxAgeMinutes
      && Number.isFinite(feesSol) && feesSol >= s.minFeesSol) return 'SOON_MIGRATED';
    const m = cfg.migrated;
    if (Number.isFinite(marketCapUsd) && marketCapUsd >= m.minMarketCapUsd && Number.isFinite(feesSol) && feesSol >= m.minFeesSol
      && (!m.requireSocial || hasSocial)) return 'MIGRATED';
    return null;
  }

  async _maybeDiscoverCandidate(mint, market, at) {
    if (!this.state.autoRun) return;
    const tier = this._classifyDiscoveryTier(market);
    if (!tier) return;
    const active = this.state.candidates.some((item) => item.mint === mint && ['OBSERVED', 'EVALUATING', 'WAITING_FOR_ROUTE'].includes(item.status));
    if (active) return;
    const lastClose = [...this.state.closedTrades].reverse().find((trade) => trade.mint === mint)?.exitAt;
    if (lastClose && at - Number(lastClose) < this.config.bot.paperAggressive.reentryCooldownSeconds * 1000) return;
    this.state.performance.signals += 1;
    const candidate = {
      id: this._id('candidate'), mint, symbol: String(market.symbol || ''), name: String(market.name || market.symbol || ''),
      lifecycleStage: String(market.lifecycleStage || tier), createdAt: this.clock(), firstSignalAt: at, lastSignalAt: at, status: 'OBSERVED',
      sourceWallets: [], sourceSignatures: [], signalTiming: {}, riskFlags: {}, security: {}, discoverySource: tier
    };
    boundedPush(this.state.candidates, candidate, this.config.bot.refined.maxRecentCandidates);
    this.state.performance.candidates += 1;
    this._event('CANDIDATE_OBSERVED', { mint, side: 'BUY', status: 'OBSERVED', reason: `GMGN_DISCOVERY_${tier}`, payload: { candidateId: candidate.id, tier } });
    this._persist();
    return this._attemptEntry(candidate);
  }

  async _evaluatePosition(mint) {
    return this._withLock(mint, async () => {
      const position = this.state.positions.find((item) => item.mint === mint);
      if (this.resetting || !position || !this.jupiterClient || this.clock() < Number(position.nextSellRetryAt || 0)) return { status: 'ignored' };
      this.state.parity.sellRouteAttempts += 1;
      const quote = await this.jupiterClient.quoteReverse({ mint, tokenAmountAtomic: position.remainingTokenAmountAtomic, purpose: 'POSITION_MARK', fresh: true });
      if (!quote.ok) {
        if (quote.outcome === 'RATE_LIMITED' || quote.errorCode === 'RATE_LIMITED') {
          position.status = 'OPEN'; position.nextSellRetryAt = this.clock() + this.config.bot.refined.temporarilyUnsellableRetryMs;
          this._event('EXIT_QUOTE_RATE_LIMITED', { decisionId: position.decisionId, positionId: position.id, mint, side: 'SELL', status: 'RATE_LIMITED', reason: 'RATE_LIMITED' });
          this._persist(); return { status: 'rate-limited' };
        }
        position.status = 'TEMPORARILY_UNSELLABLE'; position.sellRetryCount = Number(position.sellRetryCount || 0) + 1;
        position.nextSellRetryAt = this.clock() + Math.min(60_000, this.config.bot.refined.temporarilyUnsellableRetryMs * 2 ** Math.min(4, position.sellRetryCount - 1));
        position.exitAttempts.push({ at: this.clock(), status: 'NO_ROUTE', reason: quote.errorCode || 'NO_SELL_ROUTE', amountAtomic: position.remainingTokenAmountAtomic });
        this._event('POSITION_UNSELLABLE', { decisionId: position.decisionId, positionId: position.id, mint, side: 'SELL', status: position.status, reason: quote.errorCode || 'NO_SELL_ROUTE' });
        this._persist(); return { status: 'temporarily-unsellable' };
      }
      this.state.parity.sellRoutes += 1;
      position.status = 'OPEN'; position.sellRetryCount = 0; position.nextSellRetryAt = 0; position.lastQuote = sanitizeQuote(quote);
      this._recordExecutableQuote(mint, position.remainingTokenAmountAtomic, quote.outAmountAtomic, quote.receivedAt);
      const exitFee = atomic(this._feeEstimate(quote).totalLamports);
      const conservativeLiquidation = atomic(minimumOutput(quote, this.config.paper.slippageBps));
      const modelled = modelledFillOutput(quote, this.config.paper.realisticSlippageBps);
      const modelledLiquidation = atomic(modelled.atomic);
      position.lastExpectedLiquidationLamports = quote.outAmountAtomic;
      position.lastConservativeLiquidationLamports = conservativeLiquidation.toString();
      position.lastModelledLiquidationLamports = modelledLiquidation.toString();
      position.lastExitFeeEstimateLamports = exitFee.toString();
      // Mark-to-market on the same modelled basis the fill itself is priced on (Fix 2) -
      // marking against the protection floor is what made every position open 12-20% underwater.
      const unrealized = modelledLiquidation - exitFee - atomic(position.remainingEntrySpendLamports) - atomic(position.remainingEntryFeesLamports);
      const netPnl = atomic(position.realizedPnlLamports) + unrealized;
      const pnlPct = Number(netPnl * 1_000_000n / atomic(position.inputLamports)) / 10_000;
      position.mfePct = Math.max(Number(position.mfePct || 0), pnlPct);
      position.maePct = Math.min(Number(position.maePct || 0), pnlPct);
      if (!position.tp1.hit) position.maeBeforeTp1Pct = Math.min(Number(position.maeBeforeTp1Pct || 0), pnlPct);
      if (pnlPct > 0 && position.firstPositiveAt == null) { position.firstPositiveAt = this.clock(); position.timeToPositiveMs = this.clock() - position.entryAt; }
      position.consecutiveDeteriorations = position.lastExecutablePnlPct != null && pnlPct < position.lastExecutablePnlPct ? position.consecutiveDeteriorations + 1 : 0;
      position.lastExecutablePnlPct = pnlPct;
      const holdMs = this.clock() - position.entryAt;
      // Fix 3: the stop is not "armed" (allowed to fire) until whichever comes later of a
      // fixed delay after fill or a minimum number of completed marks. A sub-second stop is
      // never real information; TP1 and the runner trail are unaffected by this gate.
      position.markCount = Number(position.markCount || 0) + 1;
      const stopArmed = holdMs >= this.config.paper.stopArmingDelayMs && position.markCount >= this.config.paper.stopArmingMinQuotePolls;
      if (stopArmed && !position.stopArmedAt) {
        position.stopArmedAt = this.clock();
        this._event('STOP_ARMED', { decisionId: position.decisionId, positionId: position.id, mint, status: 'ARMED', payload: { holdMs, markCount: position.markCount } });
      }
      const cachedResearch = this.researchProvider?.getCached?.(mint);
      const currentSecurity = cachedResearch ? this._securityResult(cachedResearch, true) : position.securityResult;
      if (cachedResearch && currentSecurity?.result === 'REJECT') {
        position.securityResult = currentSecurity;
        return this._executeExit(position, position.remainingTokenAmountAtomic, 'HARD_SECURITY_DETERIORATION', { triggerAt: this.clock(), requestedReturnPct: pnlPct });
      }
      if (this.researchProvider?.inspectMint && (!cachedResearch || Number(cachedResearch.ageMs) >= this.config.gmgn.cacheMs)) {
        void this.researchProvider.inspectMint(mint, { fresh: true }).catch(() => {});
      }
      if (!position.tp1.hit && pnlPct >= 15) {
        const amount = atomic(position.remainingTokenAmountAtomic) / 2n;
        return this._executeExit(position, amount.toString(), 'TP1', { triggerAt: this.clock(), requestedReturnPct: pnlPct });
      }
      // PROFIT_LOCK: independent of TP1's breakeven-only protection, once net executable return
      // (real Jupiter reverse-sell value, not GMGN reference price) first reaches +20% this arms
      // a positive floor that trails mfePct upward using the same runner-trail distance already
      // computed at entry, so a fast reversal after a big run is caught before it can erase the
      // gain - while a still-climbing mfePct keeps the floor below the current mark, letting a
      // GUNICORN-style runner keep going.
      if (!position.profitLockArmed && pnlPct >= 20) position.profitLockArmed = true;
      if (position.profitLockArmed) {
        const floor = position.mfePct - position.runnerPolicy.trailPct;
        position.profitLockFloorPct = Math.max(position.profitLockFloorPct ?? floor, floor);
        if (pnlPct <= position.profitLockFloorPct) {
          return this._executeExit(position, position.remainingTokenAmountAtomic, 'PROFIT_LOCK', { triggerAt: this.clock(), requestedReturnPct: pnlPct, profitLockFloorPct: position.profitLockFloorPct });
        }
      }
      if (stopArmed && pnlPct <= position.stopPnlFloorPct) {
        position.stopTrigger = { triggerAt: this.clock(), requestedReturnPct: pnlPct, stopFloorPct: position.stopPnlFloorPct };
        return this._executeExit(position, position.remainingTokenAmountAtomic, 'DYNAMIC_STOP', position.stopTrigger);
      }
      if (position.tp1.hit) {
        const trailFloor = position.mfePct - position.runnerPolicy.trailPct;
        position.currentTrailFloorPct = Math.max(0, trailFloor);
        if (pnlPct <= position.currentTrailFloorPct) return this._executeExit(position, position.remainingTokenAmountAtomic, 'RUNNER_TRAIL', { triggerAt: this.clock(), requestedReturnPct: pnlPct, trailFloorPct: position.currentTrailFloorPct });
      }
      if (!position.tp1.hit && holdMs >= this.config.bot.exit.maxHoldBeforeTp1Minutes * 60_000) return this._executeExit(position, position.remainingTokenAmountAtomic, 'PRE_TP1_MAX_HOLD', { triggerAt: this.clock(), requestedReturnPct: pnlPct });
      if (position.tp1.hit && holdMs >= this.config.bot.exit.maxTotalHoldMinutes * 60_000) return this._executeExit(position, position.remainingTokenAmountAtomic, 'MAX_HOLD', { triggerAt: this.clock(), requestedReturnPct: pnlPct });
      this._persist();
      return { status: 'marked', pnlPct };
    });
  }

  async _executeExit(position, amountAtomic, reason, trigger = null) {
    const amount = atomic(amountAtomic);
    if (amount <= 0n || amount > atomic(position.remainingTokenAmountAtomic)) return { status: 'ignored', reason: 'invalid-exit-amount' };
    const decisionAt = this.clock();
    const intent = {
      decisionId: this._id('decision'), sessionId: this.state.session.id, positionId: position.id, mint: position.mint, symbol: position.symbol, side: 'SELL',
      inputMint: position.mint, outputMint: SOL_MINT, inputAmountAtomic: amount.toString(), walletEvidence: { wallets: position.sourceWallets, signatures: position.sourceSignatures },
      decisionTimestamp: decisionAt, initialQuote: null, minimumOutputAtomic: null, route: null, priceImpactPct: null,
      plannedExecutionDelayMs: this._plannedDelay(), stopModel: position.stopModel, tp1Policy: { triggerNetPnlPct: 15, sellPct: 50 }, runnerPolicy: position.runnerPolicy,
      mode: this.state.mode, status: 'QUOTING', fillQuality: null, reason, trigger, simulation: null, revalidation: null, timings: {}
    };
    boundedPush(this.state.intents, intent, this.config.bot.refined.maxIntents);
    position.exitAttempts.push({ decisionId: intent.decisionId, at: decisionAt, amountAtomic: amount.toString(), reason, status: 'QUOTING' });
    this.state.parity.sellRouteAttempts += 1;
    const initial = await this.jupiterClient.quoteReverse({ mint: position.mint, tokenAmountAtomic: amount.toString(), purpose: `EXIT_${reason}`, fresh: true });
    intent.initialQuote = sanitizeQuote(initial);
    if (!initial.ok) {
      if (initial.outcome === 'RATE_LIMITED' || initial.errorCode === 'RATE_LIMITED') return this._exitRateLimited(position, intent);
      return this._unsellableExit(position, intent, initial.errorCode || 'NO_SELL_ROUTE');
    }
    this.state.parity.sellRoutes += 1;
    intent.minimumOutputAtomic = minimumOutput(initial, this.config.paper.slippageBps);
    intent.route = initial.routePlan || []; intent.priceImpactPct = initial.priceImpactPct ?? null;
    const simulation = await this._simulate(initial); intent.simulation = simulation;
    if (simulation.attempted) this.state.parity.simulationAttempts += 1;
    if (simulation.classification === 'ACCEPTABLE') this.state.parity.simulationAccepted += 1;
    if (simulation.classification === 'DETERMINISTIC_ERROR') return this._exitNoFill(position, intent, 'DETERMINISTIC_SIMULATION_ERROR');
    intent.status = 'WAITING_LANDING'; await this.wait(intent.plannedExecutionDelayMs);
    intent.status = 'REVALIDATING'; this.state.parity.revalidations += 1;
    const fresh = await this.jupiterClient.quoteReverse({ mint: position.mint, tokenAmountAtomic: amount.toString(), purpose: `EXIT_REVALIDATE_${reason}`, fresh: true });
    intent.revalidation = sanitizeQuote(fresh);
    if (!fresh.ok) {
      if (fresh.outcome === 'RATE_LIMITED' || fresh.errorCode === 'RATE_LIMITED') return this._exitRateLimited(position, intent);
      return this._unsellableExit(position, intent, fresh.errorCode || 'NO_SELL_ROUTE');
    }
    const quoteAge = this.clock() - Number(fresh.receivedAt || 0);
    if (quoteAge > this.config.jupiter.quoteMaxAgeMs) return this._exitNoFill(position, intent, 'STALE_QUOTE');
    const modelledExit = modelledFillOutput(fresh, this.config.paper.realisticSlippageBps);
    if (atomic(modelledExit.atomic) < atomic(intent.minimumOutputAtomic)) return this._exitNoFill(position, intent, 'WOULD_FAIL_SLIPPAGE');
    this.state.parity.revalidationSuccesses += 1;
    const fees = this._feeEstimate(fresh);
    if (!this.state.positions.some((item) => item.id === position.id)) return this._exitNoFill(position, intent, 'POSITION_NO_LONGER_ACTIVE');
    return this._finalizeExit(position, intent, fresh, fees, simulation, reason, modelledExit);
  }

  _exitRateLimited(position, intent) {
    if (intent.sessionId !== this.state.session.id) return { status: 'ignored', reason: 'SESSION_FINALIZED' };
    this.state.performance.rateLimits += 1;
    position.status = 'OPEN'; position.nextSellRetryAt = this.clock() + this.config.bot.refined.temporarilyUnsellableRetryMs;
    return this._exitNoFill(position, intent, 'RATE_LIMITED');
  }

  _unsellableExit(position, intent, reason) {
    position.status = 'TEMPORARILY_UNSELLABLE'; position.sellRetryCount = Number(position.sellRetryCount || 0) + 1;
    position.nextSellRetryAt = this.clock() + Math.min(60_000, this.config.bot.refined.temporarilyUnsellableRetryMs * 2 ** Math.min(4, position.sellRetryCount - 1));
    position.exitAttempts[position.exitAttempts.length - 1].status = 'TEMPORARILY_UNSELLABLE';
    return this._exitNoFill(position, intent, reason, true);
  }

  _exitNoFill(position, intent, reason, unsellable = false) {
    if (intent.sessionId !== this.state.session.id) return { status: 'ignored', reason: 'SESSION_FINALIZED' };
    intent.status = unsellable ? 'TEMPORARILY_UNSELLABLE' : 'NO_FILL'; intent.fillQuality = FILL_QUALITY.NO_FILL; intent.reason = reason; intent.completedAt = this.clock();
    this.state.parity.fillQualities.NO_FILL += 1;
    this._event('EXIT_NO_FILL', { decisionId: intent.decisionId, positionId: position.id, mint: position.mint, side: 'SELL', status: intent.status, reason, payload: { amountAtomic: intent.inputAmountAtomic, intent } });
    this._persist(); return { status: unsellable ? 'temporarily-unsellable' : 'no-fill', reason, decisionId: intent.decisionId, fillQuality: FILL_QUALITY.NO_FILL };
  }

  _finalizeExit(position, intent, quote, fees, simulation, reason, modelledExit) {
    if (intent.sessionId !== this.state.session.id || !this.state.positions.some((item) => item.id === position.id)) return { status: 'ignored', reason: 'SESSION_FINALIZED' };
    if (intent.mode !== 'BOT_PAPER') return this._exitNoFill(position, intent, 'LIVE_EXECUTION_ADAPTER_NOT_INSTALLED');
    const at = this.clock();
    const sold = atomic(intent.inputAmountAtomic);
    const expectedProceeds = atomic(quote.outAmountAtomic);
    const modelled = modelledExit || modelledFillOutput(quote, this.config.paper.realisticSlippageBps);
    const proceeds = atomic(modelled.atomic);
    const conservativeProceeds = atomic(minimumOutput(quote, this.config.paper.slippageBps));
    const fee = atomic(fees.totalLamports);
    const balanceBefore = atomic(position.remainingTokenAmountAtomic);
    const finalSlice = sold === balanceBefore;
    const allocatedSpend = finalSlice ? atomic(position.remainingEntrySpendLamports) : atomic(position.remainingEntrySpendLamports) * sold / balanceBefore;
    const allocatedEntryFees = finalSlice ? atomic(position.remainingEntryFeesLamports) : atomic(position.remainingEntryFeesLamports) * sold / balanceBefore;
    const realized = proceeds - fee - allocatedSpend - allocatedEntryFees;
    const allocatedCost = allocatedSpend + allocatedEntryFees;
    const actualFillReturnPct = allocatedCost > 0n ? Number(realized * 1_000_000n / allocatedCost) / 10_000 : 0;
    const quality = this._fillQuality(quote, simulation, fees);
    const fill = {
      id: this._id('fill'), decisionId: intent.decisionId, positionId: position.id, at, side: 'SELL', exitReason: reason, fillQuality: quality,
      inputMint: position.mint, outputMint: SOL_MINT, inputAmountAtomic: sold.toString(), outputAmountAtomic: proceeds.toString(),
      expectedOutputAmountAtomic: expectedProceeds.toString(), conservativeOutputAmountAtomic: conservativeProceeds.toString(),
      modelledFillOutputAtomic: proceeds.toString(), modelledSlippageBps: modelled.slippageBps,
      allocatedEntrySpendLamports: allocatedSpend.toString(), allocatedEntryFeesLamports: allocatedEntryFees.toString(),
      realizedPnlLamports: realized.toString(), actualFillReturnPct,
      minimumOutputAtomic: intent.minimumOutputAtomic, requestId: quote.requestId, router: quote.router, fees, simulation, revalidatedQuote: sanitizeQuote(quote)
    };
    position.remainingTokenAmountAtomic = (atomic(position.remainingTokenAmountAtomic) - sold).toString();
    position.remainingEntrySpendLamports = (atomic(position.remainingEntrySpendLamports) - allocatedSpend).toString();
    position.remainingEntryFeesLamports = (atomic(position.remainingEntryFeesLamports) - allocatedEntryFees).toString();
    position.grossExitProceedsLamports = (atomic(position.grossExitProceedsLamports) + proceeds).toString();
    position.grossExitProceedsConservativeLamports = (atomic(position.grossExitProceedsConservativeLamports || '0') + conservativeProceeds).toString();
    position.exitFeesLamports = (atomic(position.exitFeesLamports) + fee).toString();
    position.realizedPnlLamports = (atomic(position.realizedPnlLamports) + realized).toString();
    this.state.session.balanceLamports = (atomic(this.state.session.balanceLamports) + proceeds - fee).toString();
    boundedPush(this.state.fills, fill, this.config.bot.refined.maxFills);
    intent.status = 'FILLED'; intent.fillQuality = quality; intent.fillId = fill.id; intent.completedAt = at;
    this.state.parity.fillQualities[quality] += 1; if (fees.complete) this.state.parity.feeComplete += 1;
    position.exitAttempts[position.exitAttempts.length - 1].status = 'FILLED';
    position.exitAttempts[position.exitAttempts.length - 1].fillId = fill.id;
    if (reason === 'TP1') {
      const before = position.stopPnlFloorPct;
      position.tp1 = { hit: true, fillId: fill.id, at, requestedReturnPct: intent.trigger?.requestedReturnPct ?? null, actualFillReturnPct };
      position.stage = 'AFTER_TP1'; position.stopPnlFloorPct = Math.max(0, position.stopPnlFloorPct); position.currentStopPct = 0;
      const change = { at, beforePct: before, afterPct: position.stopPnlFloorPct, reason: 'TP1_BREAK_EVEN_PROTECTION' };
      position.stopChanges.push(change);
      this._event('STOP_TIGHTENED', { decisionId: intent.decisionId, positionId: position.id, mint: position.mint, status: 'TIGHTENED', reason: change.reason, payload: change });
      this._event('TP1_FILLED', { decisionId: intent.decisionId, positionId: position.id, mint: position.mint, side: 'SELL', status: 'AFTER_TP1', payload: fill });
    }
    if (reason === 'DYNAMIC_STOP') {
      const stopFloor = Number(intent.trigger?.stopFloorPct ?? position.stopPnlFloorPct);
      position.stopOvershootPct = Math.max(0, stopFloor - actualFillReturnPct);
      position.stopTrigger = { ...(position.stopTrigger || intent.trigger || {}), actualFillReturnPct, stopOvershootPct: position.stopOvershootPct, fillAt: at };
    }
    if (atomic(position.remainingTokenAmountAtomic) === 0n) this._closePosition(position, intent, reason, quality, at);
    else this._persist();
    return { status: 'filled', decisionId: intent.decisionId, positionId: position.id, fillQuality: quality, fill };
  }

  _closePosition(position, intent, reason, fillQuality, at, status = 'CLOSED', executable = true) {
    const entryIntent = this.state.intents.find((item) => item.decisionId === position.decisionId) || null;
    const entryFill = this.state.fills.find((item) => item.id === position.entryFillId) || null;
    const positionFills = this.state.fills.filter((fill) => fill.positionId === position.id);
    const sellFills = positionFills.filter((fill) => fill.side === 'SELL');
    const allFees = positionFills.map((fill) => fill.fees || {});
    const feeSum = (key) => allFees.reduce((sum, fees) => sum + safeAtomic(fees[key]), 0n).toString();
    // Fix 4: ATA-creation rent is refundable when the token account is closed, so it is not
    // a realised loss. It is still fully visible on the trade row - just excluded from netPnlPct.
    const recoverableRentLamports = atomic(feeSum('rentFeeLamports'));
    const grossFees = atomic(position.entryFeesLamports) + atomic(position.exitFeesLamports);
    const net = atomic(position.grossExitProceedsLamports) - atomic(position.inputLamports) - grossFees + recoverableRentLamports;
    const netPct = Number(net * 1_000_000n / atomic(position.inputLamports)) / 10_000;
    this.state.session.rentOutstandingLamports = (atomic(this.state.session.rentOutstandingLamports || '0') + recoverableRentLamports).toString();
    const holdMs = Math.max(0, at - position.entryAt);
    position.stage = 'CLOSED'; position.status = status; position.realizedPnlLamports = net.toString();
    const trade = {
      id: this._id('trade'), sessionId: this.state.session.id, strategyVersion: this.state.strategyVersion,
      stopModelVersion: this.config.bot.refined.stopModelVersion, decisionId: position.decisionId, finalDecisionId: intent?.decisionId || '', positionId: position.id,
      mint: position.mint, symbol: position.symbol, name: position.name, tokenIdentity: position.tokenIdentity, status, executable,
      censored: !executable, unsellable: /UNSELLABLE/.test(`${status}:${reason}`), unrecoveredTokenAmountAtomic: executable ? '0' : position.remainingTokenAmountAtomic, classification: position.classification,
      entryAt: position.entryAt, exitAt: at, holdMs, exitReason: reason, fillQuality: entryFill?.fillQuality || fillQuality, finalFillQuality: fillQuality,
      inputLamports: position.inputLamports, tokenAmountAtomic: position.initialTokenAmountAtomic, exitProceedsLamports: position.grossExitProceedsLamports,
      feesLamports: (atomic(position.entryFeesLamports) + atomic(position.exitFeesLamports)).toString(), netPnlLamports: net.toString(), netPnlPct: netPct,
      recoverableRentLamports: recoverableRentLamports.toString(),
      mfePct: position.mfePct, maePct: position.maePct, maeBeforeTp1Pct: position.maeBeforeTp1Pct, timeToPositiveMs: position.timeToPositiveMs, tp1Hit: position.tp1.hit, sourceWallets: position.sourceWallets, sourceSignatures: position.sourceSignatures,
      lifecycleStage: position.lifecycleStage, liquidityBand: position.liquidityBand, stopModel: position.stopModel, stopChanges: position.stopChanges,
      initialStopPct: position.frozenStopPct, finalStopFloorPct: position.stopPnlFloorPct, tp1: position.tp1, runnerPolicy: position.runnerPolicy,
      stopTrigger: position.stopTrigger, stopOvershootPct: position.stopOvershootPct, exitAttempts: position.exitAttempts,
      signalAgeMs: entryIntent?.snapshot?.signal_age_ms ?? null, sizing: position.sizing,
      solUsd: position.sizing?.solUsd || null, targetUsd: position.sizing?.targetUsd || null,
      entryExpectedTokenAtomic: entryFill?.expectedOutputAmountAtomic || null, entryConservativeTokenAtomic: entryFill?.conservativeOutputAmountAtomic || null,
      entryModelledTokenAtomic: entryFill?.modelledFillOutputAtomic || position.initialTokenAmountAtomic,
      expectedExitProceedsLamports: positionFills.filter((fill) => fill.side === 'SELL').reduce((sum, fill) => sum + safeAtomic(fill.expectedOutputAmountAtomic), 0n).toString(),
      conservativeExitProceedsLamports: position.grossExitProceedsConservativeLamports || '0',
      exitModelledProceedsLamports: position.grossExitProceedsLamports,
      networkFeesLamports: feeSum('networkFeeLamports'), priorityFeesLamports: feeSum('priorityFeeLamports'), rentFeesLamports: feeSum('rentFeeLamports'),
      entryFeeEvidence: entryFill?.fees?.evidence || 'MODELLED',
      exitFeeEvidence: sellFills.length && sellFills.every((fill) => fill.fees?.evidence === 'ROUTE_REPORTED') ? 'ROUTE_REPORTED' : 'MODELLED',
      securityResult: position.securityResult, brain: entryIntent?.mathematics?.brain || null,
      brainAction: entryIntent?.mathematics?.brain?.action || null, brainControlAction: entryIntent?.mathematics?.brain?.controlAction || null,
      momentumPct: entryIntent?.mathematics?.momentumPct ?? null, trajectory: entryIntent?.mathematics?.trajectory || null,
      entryReason: position.discoverySource ? `GMGN_DISCOVERY_${position.discoverySource}` : 'FRESH_TRACKED_WALLET_BUY', entryClassification: position.classification,
      distinctWallets: entryIntent?.mathematics?.brain?.distinctFreshWallets ?? position.sourceWallets.length,
      clusterAdjustedWeight: entryIntent?.mathematics?.brain?.clusterAdjustedWeight ?? null,
      grossPnlLamports: (atomic(position.grossExitProceedsLamports) - atomic(position.inputLamports)).toString()
    };
    boundedPush(this.state.closedTrades, trade, this.config.bot.refined.maxClosedTrades);
    this.state.positions = this.state.positions.filter((item) => item.id !== position.id);
    const reconstructableRecord = {
      trade,
      entryExecutionIntent: entryIntent,
      exitExecutionIntents: this.state.intents.filter((item) => item.positionId === position.id),
      fills: this.state.fills.filter((fill) => fill.positionId === position.id)
    };
    try {
      this.auditWriter?.writeTrade?.({
        strategy_version: trade.strategyVersion, stop_model_version: trade.stopModelVersion, session_id: trade.sessionId, trade_id: trade.id,
        decision_id: trade.decisionId, position_id: trade.positionId, mint: trade.mint, symbol: trade.symbol, name: trade.name, status: trade.status,
        executable: trade.executable, censored: trade.censored, unsellable: trade.unsellable,
        entry_timestamp_utc: nowIso(trade.entryAt), exit_timestamp_utc: nowIso(trade.exitAt), hold_ms: trade.holdMs, signal_age_ms: trade.signalAgeMs,
        source_wallets: trade.sourceWallets.map((item) => item.address), source_signatures: trade.sourceSignatures, distinct_wallets: trade.distinctWallets,
        cluster_adjusted_weight: trade.clusterAdjustedWeight, brain_evidence_grade: trade.brain?.evidenceGrade || '',
        brain_action: trade.brainAction || '', brain_control_action: trade.brainControlAction || '', tp1_posterior_mean: trade.brain?.tp1Posterior?.mean ?? '',
        security_result: trade.securityResult?.result || '', security_reason: trade.securityResult?.reason || '', momentum_pct: trade.momentumPct,
        trajectory_label: trade.trajectory?.label || '', entry_reason: trade.entryReason, classification: trade.entryClassification,
        exit_reason: trade.exitReason, fill_quality: trade.fillQuality, sizing_mode: trade.sizing?.mode, target_usd: trade.targetUsd, submitted_sol: trade.sizing?.submittedSol, sol_usd: trade.solUsd,
        input_lamports: trade.inputLamports, token_amount_atomic: trade.tokenAmountAtomic, exit_proceeds_lamports: trade.exitProceedsLamports,
        entry_expected_token_atomic: trade.entryExpectedTokenAtomic, entry_conservative_token_atomic: trade.entryConservativeTokenAtomic,
        entry_modelled_token_atomic: trade.entryModelledTokenAtomic,
        expected_exit_proceeds_lamports: trade.expectedExitProceedsLamports, conservative_exit_proceeds_lamports: trade.conservativeExitProceedsLamports,
        exit_modelled_proceeds_lamports: trade.exitModelledProceedsLamports,
        network_fees_lamports: trade.networkFeesLamports, priority_fees_lamports: trade.priorityFeesLamports, rent_fees_lamports: trade.rentFeesLamports,
        recoverable_rent_lamports: trade.recoverableRentLamports,
        fees_lamports: trade.feesLamports, fee_evidence: `${trade.entryFeeEvidence}/${trade.exitFeeEvidence}`,
        initial_stop_pct: trade.initialStopPct, stop_evidence: trade.stopModel?.evidence, tp1_hit: trade.tp1Hit, tp1_fill_return_pct: trade.tp1?.actualFillReturnPct,
        runner_trail_pct: trade.runnerPolicy?.trailPct, mfe_pct: trade.mfePct, mae_pct: trade.maePct, hold_duration_ms: trade.holdMs,
        gross_pnl_lamports: trade.grossPnlLamports, net_pnl_lamports: trade.netPnlLamports, net_pnl_pct: trade.netPnlPct,
        stop_overshoot_pct: trade.stopOvershootPct, record_json: reconstructableRecord
      });
    } catch (error) { this.state.services = { ...this.state.services, audit: 'degraded', auditError: String(error.message || error).slice(0, 300) }; }
    this._writeWalletStats(trade);
    this._event('POSITION_CLOSED', { decisionId: intent?.decisionId || '', positionId: position.id, mint: position.mint, side: 'SELL', status, reason, payload: { tradeId: trade.id, netPnlLamports: trade.netPnlLamports, fillQuality } });
    this._persist();
    return trade;
  }

  _writeWalletStats(trade) {
    for (const wallet of trade.sourceWallets.map((item) => item.address)) {
      const tradesByMint = new Map();
      for (const item of this.state.closedTrades.filter((closed) => closed.executable !== false && closed.sourceWallets?.some((source) => (source.address || source) === wallet))) tradesByMint.set(item.mint, item);
      const records = [...tradesByMint.values()];
      const tp1 = betaPosterior({ successes: records.filter((item) => item.tp1Hit).length, trials: records.length, priorMean: 0.4, priorEquivalentSampleSize: this.config.bot.brain.priorEquivalentSampleSize });
      const profitable = betaPosterior({ successes: records.filter((item) => Number(item.netPnlLamports) > 0).length, trials: records.length, priorMean: 0.5, priorEquivalentSampleSize: this.config.bot.brain.priorEquivalentSampleSize });
      const record = { wallet, uniqueMints: records.length, tp1Successes: tp1.successes, profitableTrades: profitable.successes, tp1Posterior: tp1, profitablePosterior: profitable };
      try {
        this.auditWriter?.writeWalletStats?.({ session_id: this.state.session.id, stats_id: `${trade.id}:${wallet}`, timestamp_utc: nowIso(trade.exitAt), wallet, unique_mints: records.length, tp1_successes: tp1.successes, profitable_trades: profitable.successes, tp1_posterior_mean: tp1.mean, profitable_posterior_mean: profitable.mean, record_json: record });
      } catch (error) { this.state.services = { ...this.state.services, audit: 'degraded', auditError: String(error.message || error).slice(0, 300) }; }
    }
  }

  async reset() {
    this.resetting = true;
    try { return await this._resetInternal(); }
    finally { this.resetting = false; }
  }

  async _resetInternal() {
    this.state.autoRun = false;
    for (const candidate of this.state.candidates.filter((item) => ['OBSERVED', 'EVALUATING', 'WAITING_FOR_ROUTE'].includes(item.status))) this._expireCandidate(candidate, 'SESSION_RESET');
    const open = [...this.state.positions];
    const results = [];
    const deadlineAt = Date.now() + 20_000;
    const closeTasks = open.map(async (position) => {
      while (this.locks.has(position.mint) && Date.now() < deadlineAt) await this.wait(Math.min(100, Math.max(1, deadlineAt - Date.now())));
      if (Date.now() >= deadlineAt) return { positionId: position.id, status: 'deadline' };
      if (!this.state.positions.some((item) => item.id === position.id)) return { positionId: position.id, status: 'already-closed' };
      const result = await this._withLock(position.mint, () => this._executeExit(position, position.remainingTokenAmountAtomic, 'RESET_CLOSE', { triggerAt: this.clock(), deadlineAt }));
      return { positionId: position.id, ...result };
    }).map((task) => task.then(
      (result) => { results.push(result); return result; },
      (error) => { const result = { status: 'failed', reason: String(error?.message || error) }; results.push(result); return result; }
    ));
    const settled = Promise.all(closeTasks);
    let deadlineTimer = null;
    await Promise.race([
      settled,
      new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(null), Math.max(1, deadlineAt - Date.now())); })
    ]);
    clearTimeout(deadlineTimer);
    for (const position of open.filter((item) => this.state.positions.some((active) => active.id === item.id))) {
      position.status = 'UNSELLABLE_CLOSED';
      const intent = [...this.state.intents].reverse().find((item) => item.positionId === position.id) || null;
      this._closePosition(position, intent, 'UNSELLABLE_CLOSED', FILL_QUALITY.NO_FILL, this.clock(), 'UNSELLABLE_CLOSED', false);
      if (!results.some((item) => item.positionId === position.id)) results.push({ positionId: position.id, status: 'unsellable-closed', reason: 'RESET_DEADLINE_OR_NO_ROUTE' });
    }
    const previousSessionId = this.state.session.id;
    const retainedClosed = this.state.closedTrades;
    const sessionHistory = [...this.state.sessionHistory, { session: { ...this.state.session }, finalizedAt: this.clock(), stats: this._derivedStats(), closeResults: results.map((item) => ({ ...item })) }].slice(-100);
    const sequence = this.state.sequence;
    const services = this.state.services;
    const restartCount = this.state.restartCount;
    this.state = initialState(this.config, this.clock, sequence, retainedClosed, sessionHistory);
    this.state.autoRun = false;
    this.state.services = services; this.state.restartCount = restartCount;
    this._event('NEW_SESSION', { status: 'PAUSED', reason: 'CLOSE_ALL_AND_NEW_SESSION', payload: { previousSessionId, closeResults: results } });
    this._persist();
    return { status: 'reset', previousSessionId, sessionId: this.state.session.id, closed: results.length, results };
  }

  reconcile() {
    const positionIds = new Set(this.state.positions.map((position) => position.id));
    const duplicatePositions = positionIds.size !== this.state.positions.length;
    const fillIds = new Set(this.state.fills.map((fill) => fill.id));
    return { status: duplicatePositions || fillIds.size !== this.state.fills.length ? 'mismatch' : 'reconciled', authoritativeState: STATE_SCHEMA, positions: this.state.positions.length, fills: this.state.fills.length, duplicatePositions, duplicateFills: fillIds.size !== this.state.fills.length };
  }

  getActiveMints() {
    return [...new Set([...this.state.positions.map((item) => item.mint), ...this.state.candidates.filter((item) => ['OBSERVED', 'EVALUATING', 'WAITING_FOR_ROUTE'].includes(item.status)).map((item) => item.mint)])];
  }

  startAutomation() {
    if (this.timer) return;
    this.timer = setInterval(() => { for (const position of [...this.state.positions]) void this._evaluatePosition(position.mint); }, 1000);
    this.timer.unref?.();
  }

  stopAutomation() {
    clearInterval(this.timer); this.timer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; this._persist(); }
  }

  _derivedStats() {
    const sessionTrades = this.state.closedTrades.filter((trade) => trade.sessionId === this.state.session.id && trade.executable !== false);
    const censoredTrades = this.state.closedTrades.filter((trade) => trade.sessionId === this.state.session.id && trade.executable === false);
    const closedOutcomes = [...sessionTrades, ...censoredTrades];
    const closedRealized = closedOutcomes.reduce((sum, trade) => sum + atomic(trade.netPnlLamports), 0n);
    const openRealized = this.state.positions.reduce((sum, position) => sum + atomic(position.realizedPnlLamports), 0n);
    const realized = closedRealized + openRealized;
    let unrealized = 0n;
    let liquidation = 0n;
    for (const position of this.state.positions) {
      const value = safeAtomic(position.lastModelledLiquidationLamports ?? position.lastConservativeLiquidationLamports);
      const exitFee = safeAtomic(position.lastExitFeeEstimateLamports || this._feeEstimate(position.lastQuote || {}).totalLamports);
      liquidation += value;
      unrealized += value - exitFee - atomic(position.remainingEntrySpendLamports) - atomic(position.remainingEntryFeesLamports);
    }
    const cash = atomic(this.state.session.balanceLamports);
    const equity = cash + liquidation;
    const totalNet = realized + unrealized;
    const grossProfit = closedOutcomes.filter((trade) => atomic(trade.netPnlLamports) > 0n).reduce((sum, trade) => sum + atomic(trade.netPnlLamports), 0n);
    const grossLoss = closedOutcomes.filter((trade) => atomic(trade.netPnlLamports) < 0n).reduce((sum, trade) => sum + atomic(trade.netPnlLamports), 0n);
    const deployed = closedOutcomes.reduce((sum, trade) => sum + atomic(trade.inputLamports), 0n) + this.state.positions.reduce((sum, position) => sum + atomic(position.inputLamports), 0n);
    const returns = closedOutcomes.map((trade) => Number(trade.netPnlPct || 0));
    const holds = closedOutcomes.map((trade) => Number(trade.holdMs || 0));
    let running = 0n; let peak = 0n; let maximumDrawdown = 0n;
    for (const trade of [...closedOutcomes].sort((a, b) => a.exitAt - b.exitAt)) {
      running += atomic(trade.netPnlLamports); peak = running > peak ? running : peak;
      const drawdown = peak - running; maximumDrawdown = drawdown > maximumDrawdown ? drawdown : maximumDrawdown;
    }
    const wins = closedOutcomes.filter((trade) => atomic(trade.netPnlLamports) > 0n).length;
    const losses = closedOutcomes.filter((trade) => atomic(trade.netPnlLamports) <= 0n).length;
    const tp1Opportunities = closedOutcomes.length + this.state.positions.length;
    const tp1Captures = closedOutcomes.filter((trade) => trade.tp1Hit).length + this.state.positions.filter((position) => position.tp1.hit).length;
    const solUsd = Number(this.jupiterClient?.solUsdCache?.price || 0);
    const toUsd = (lamports) => solUsd > 0 ? Number(usdMicrosFromLamports(lamports, String(solUsd))) / 1e6 : null;
    const stopOvershoots = closedOutcomes.filter((trade) => Number.isFinite(Number(trade.stopOvershootPct))).map((trade) => Number(trade.stopOvershootPct));
    return {
      cashLamports: cash.toString(), cashSol: atomicToDecimalString(cash, 9), balanceSol: atomicToDecimalString(cash, 9),
      liquidationLamports: liquidation.toString(), liquidationSol: atomicToDecimalString(liquidation, 9),
      equityLamports: equity.toString(), equitySol: atomicToDecimalString(equity, 9),
      realizedPnlLamports: realized.toString(), realizedPnlSol: atomicToDecimalString(realized, 9), unrealizedPnlLamports: unrealized.toString(), unrealizedPnlSol: atomicToDecimalString(unrealized, 9),
      totalNetPnlLamports: totalNet.toString(), totalNetPnlSol: atomicToDecimalString(totalNet, 9),
      cashUsd: toUsd(cash), equityUsd: toUsd(equity), realizedPnlUsd: toUsd(realized), unrealizedPnlUsd: toUsd(unrealized), totalNetPnlUsd: toUsd(totalNet), solUsd: solUsd || null,
      signals: this.state.performance.signals, candidates: this.state.performance.candidates, paperFills: this.state.performance.paperFills,
      closedTrades: closedOutcomes.length, executableClosedTrades: sessionTrades.length, censoredTrades: censoredTrades.length, wins, losses,
      winRatePct: closedOutcomes.length ? wins / closedOutcomes.length * 100 : 0, openPositions: this.state.positions.length,
      grossProfitLamports: grossProfit.toString(), grossProfitSol: atomicToDecimalString(grossProfit, 9), grossLossLamports: grossLoss.toString(), grossLossSol: atomicToDecimalString(grossLoss, 9),
      returnOnDeployedCapitalPct: deployed > 0n ? Number(totalNet * 1_000_000n / deployed) / 10_000 : 0,
      profitFactor: grossLoss < 0n ? Number(grossProfit) / Number(-grossLoss) : grossProfit > 0n ? null : 0,
      expectancyPerTradeSol: closedOutcomes.length ? Number(closedRealized) / 1e9 / closedOutcomes.length : 0,
      expectancyPerTradePct: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
      medianTradeReturnPct: percentile(returns, 0.5), bestTradeReturnPct: returns.length ? Math.max(...returns) : null, worstTradeReturnPct: returns.length ? Math.min(...returns) : null,
      maximumDrawdownLamports: maximumDrawdown.toString(), maximumDrawdownSol: atomicToDecimalString(maximumDrawdown, 9),
      averageHoldMs: holds.length ? holds.reduce((sum, value) => sum + value, 0) / holds.length : 0, medianHoldMs: percentile(holds, 0.5),
      tp1Captures, tp1Opportunities, averageStopOvershootPct: stopOvershoots.length ? stopOvershoots.reduce((sum, value) => sum + value, 0) / stopOvershoots.length : null,
      rateLimitCount: this.state.performance.rateLimits,
      rentOutstandingLamports: this.state.session.rentOutstandingLamports || '0', rentOutstandingSol: atomicToDecimalString(this.state.session.rentOutstandingLamports || '0', 9),
      brainDivergence: this._brainDivergenceSplit(closedOutcomes)
    };
  }

  // Fix 6: Group A = brain approved (action === controlAction === 'BUY'); Group B = brain vetoed
  // but the frozen control policy traded anyway. Compares them so the gate can be flipped on
  // evidence instead of blind once there is a real sample (see respectBrainHardGate).
  _brainDivergenceSplit(closedOutcomes) {
    const groupA = closedOutcomes.filter((trade) => trade.brainAction === 'BUY');
    const groupB = closedOutcomes.filter((trade) => trade.brainAction === 'OBSERVE' && trade.brainControlAction === 'BUY');
    const summarize = (trades) => {
      const returns = trades.map((trade) => Number(trade.netPnlPct || 0));
      const wins = trades.filter((trade) => atomic(trade.netPnlLamports) > 0n).length;
      const tp1 = trades.filter((trade) => trade.tp1Hit).length;
      return {
        count: trades.length,
        meanNetPnlPct: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
        medianNetPnlPct: percentile(returns, 0.5),
        winRatePct: trades.length ? wins / trades.length * 100 : null,
        tp1HitRatePct: trades.length ? tp1 / trades.length * 100 : null
      };
    };
    return { groupA: summarize(groupA), groupB: summarize(groupB) };
  }

  _paritySnapshot() {
    const parity = this.state.parity;
    const rate = (part, total) => total ? part / total * 100 : 0;
    const executableFills = parity.fillQualities.SIMULATED_BUILDABLE + parity.fillQualities.BUILDABLE_UNSIMULATED + parity.fillQualities.QUOTE_PARITY;
    const buildableFills = parity.fillQualities.SIMULATED_BUILDABLE + parity.fillQualities.BUILDABLE_UNSIMULATED;
    const providerRequests = Number(this.jupiterClient?.metrics?.requests || 0);
    const providerRateLimits = Number(this.jupiterClient?.metrics?.rateLimited || 0);
    return {
      exactRouteCoveragePct: rate(parity.exactRoutes, parity.routeAttempts), buildableTransactionRatePct: rate(parity.buildable, parity.exactRoutes),
      buildableFillRatePct: rate(buildableFills, executableFills), simulationCoveragePct: rate(parity.fillQualities.SIMULATED_BUILDABLE, executableFills), simulationAcceptancePct: rate(parity.simulationAccepted, parity.simulationAttempts),
      revalidationSuccessPct: rate(parity.revalidationSuccesses, parity.revalidations), completeFeeCoveragePct: rate(parity.feeComplete, this.state.fills.length),
      sellRouteCoveragePct: rate(parity.sellRoutes, parity.sellRouteAttempts), quoteAgeP75Ms: percentile(this.state.latency.quoteAgeMs, 0.75),
      signalToDecisionP50Ms: percentile(this.state.latency.signalToDecisionMs, 0.5), signalToDecisionP75Ms: percentile(this.state.latency.signalToDecisionMs, 0.75),
      decisionToFillP50Ms: percentile(this.state.latency.decisionToFillMs, 0.5), decisionToFillP75Ms: percentile(this.state.latency.decisionToFillMs, 0.75),
      signalToFillP75Ms: percentile(this.state.latency.signalToFillMs, 0.75),
      providerRateLimitCount: providerRateLimits, providerRateLimitRatePct: rate(providerRateLimits, providerRequests),
      staleSignalDrops: parity.staleSignalDrops, fillQualities: { ...parity.fillQualities }, counts: { ...parity }
    };
  }

  snapshot(mint = '') {
    const started = process.hrtime.bigint();
    const positions = this.state.positions.map((position) => {
      const liquidation = safeAtomic(position.lastModelledLiquidationLamports ?? position.lastConservativeLiquidationLamports);
      const exitFee = safeAtomic(position.lastExitFeeEstimateLamports || this._feeEstimate(position.lastQuote || {}).totalLamports);
      const remainingUnrealized = liquidation - exitFee - atomic(position.remainingEntrySpendLamports) - atomic(position.remainingEntryFeesLamports);
      const net = atomic(position.realizedPnlLamports) + remainingUnrealized;
      const solUsd = Number(position.sizing?.solUsd || this.jupiterClient?.solUsdCache?.price || 0);
      const toUsd = (lamports) => solUsd > 0 ? Number(usdMicrosFromLamports(lamports, String(solUsd))) / 1e6 : null;
      const holdMs = Math.max(0, this.clock() - position.entryAt);
      const stopArmed = Boolean(position.stopArmedAt);
      return {
        ...position,
        holdMs,
        entryAmountSol: atomicToDecimalString(position.inputLamports, 9), entryAmountUsd: position.sizing?.targetUsd ?? toUsd(position.inputLamports),
        currentLiquidationLamports: liquidation.toString(), currentLiquidationSol: atomicToDecimalString(liquidation, 9), currentLiquidationUsd: toUsd(liquidation),
        currentNetPnlLamports: net.toString(), currentNetPnlSol: atomicToDecimalString(net, 9), currentNetPnlUsd: toUsd(net),
        currentNetPnlPct: Number(net * 1_000_000n / atomic(position.inputLamports)) / 10_000,
        sourceWalletCount: new Set(position.sourceWallets.map((item) => item.address || item)).size,
        stopEvidenceLabel: position.stopModel?.fallbackApplied ? 'FALLBACK - INSUFFICIENT COIN EVIDENCE' : 'COIN-SPECIFIC',
        tp1TargetPct: 15, currentTrailPct: position.tp1.hit ? position.runnerPolicy.trailPct : null,
        maximumExitAt: position.entryAt + (position.tp1.hit ? this.config.bot.exit.maxTotalHoldMinutes : this.config.bot.exit.maxHoldBeforeTp1Minutes) * 60_000,
        stopArmingState: stopArmed ? 'STOP_ARMED' : 'STOP_PENDING',
        stopArmingRemainingMs: stopArmed ? 0 : Math.max(0, this.config.paper.stopArmingDelayMs - holdMs)
      };
    });
    const stats = this._derivedStats();
    const result = {
      ok: true, schemaVersion: STATE_SCHEMA, strategy: this.state.strategyVersion, stopModelVersion: this.config.bot.refined.stopModelVersion,
      mode: this.state.mode, autoRun: this.state.autoRun, status: this.state.autoRun ? 'RUNNING' : 'PAUSED', session: this.state.session,
      stats, positions, recentCandidates: this.state.candidates.slice(-25).reverse(), recentActivity: this.state.activity.slice(-50).reverse(),
      recentIntents: this.state.intents.slice(-25).reverse().map((intent) => ({ decisionId: intent.decisionId, candidateId: intent.candidateId, positionId: intent.positionId, mint: intent.mint, symbol: intent.symbol, name: intent.name, tokenIdentity: intent.tokenIdentity, side: intent.side, status: intent.status, reason: intent.reason, classification: intent.classification, fillQuality: intent.fillQuality, stopModel: intent.stopModel, securityResult: intent.securityResult, sizing: intent.sizing, mathematics: intent.mathematics, simulation: intent.simulation })),
      recentFills: this.state.fills.slice(-25).reverse(),
      recentClosedTrades: this.state.closedTrades.filter((trade) => trade.sessionId === this.state.session.id).slice(-50).reverse().map((trade) => ({
        id: trade.id, mint: trade.mint, symbol: trade.symbol, exitAt: trade.exitAt, holdMs: trade.holdMs,
        exitReason: trade.exitReason, netPnlLamports: trade.netPnlLamports, netPnlPct: trade.netPnlPct, tp1Hit: trade.tp1Hit
      })),
      parity: this._paritySnapshot(), services: { ...this.state.services, jupiter: this.jupiterClient?.status?.() || null, gmgn: this.researchProvider?.status?.() || this.state.services.gmgn || null },
      candidateWalletCount: this.config.wallets.filter((wallet) => wallet.enabled !== false).length,
      selected: mint ? { mint, position: positions.find((position) => position.mint === mint) || null, market: this.markets.get(mint) || null } : null,
      advanced: { memoryMb: process.memoryUsage().rss / 1024 / 1024, intentCount: this.state.intents.length, fillCount: this.state.fills.length, audit: this.auditWriter?.status?.() || null, restartCount: this.state.restartCount, sessionHistoryCount: this.state.sessionHistory.length },
      generatedAt: this.clock()
    };
    result.responseBuildMs = Number(process.hrtime.bigint() - started) / 1e6;
    return result;
  }

  exportClosedTradesCsv() {
    const headers = ['session_id', 'trade_id', 'position_id', 'mint', 'status', 'entry_at', 'exit_at', 'exit_reason', 'fill_quality', 'input_lamports', 'exit_proceeds_lamports', 'fees_lamports', 'net_pnl_lamports', 'net_pnl_pct', 'mfe_pct', 'mae_pct'];
    const escape = (value) => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
    return `${headers.join(',')}\r\n${this.state.closedTrades.map((trade) => [trade.sessionId, trade.id, trade.positionId, trade.mint, trade.status, nowIso(trade.entryAt), nowIso(trade.exitAt), trade.exitReason, trade.fillQuality, trade.inputLamports, trade.exitProceedsLamports, trade.feesLamports, trade.netPnlLamports, trade.netPnlPct, trade.mfePct, trade.maePct].map(escape).join(',')).join('\r\n')}\r\n`;
  }
}

module.exports = { FILL_QUALITY, RefinedPaperEngine, STATE_SCHEMA, initialState, minimumOutput, sanitizeQuote };
