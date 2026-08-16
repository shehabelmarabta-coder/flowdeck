'use strict';

const { randomUUID } = require('node:crypto');
const { PaperEngine, ADDRESS_RE } = require('./engine');
const { RollingConsensus } = require('./consensus');

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function iso(timestamp) { return timestamp == null ? '' : new Date(timestamp).toISOString(); }
function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }

function freshBotState(previous = {}) {
  const migratedCandidates = previous.candidates && typeof previous.candidates === 'object' ? previous.candidates : {};
  if (previous.candidate?.mint && !migratedCandidates[previous.candidate.mint]) migratedCandidates[previous.candidate.mint] = previous.candidate;
  const pending = previous.pendingDecision || null;
  const positions = previous.positions && typeof previous.positions === 'object' ? previous.positions : {};
  const needsReconciliation = Boolean(pending && pending.status !== 'failed');
  if (!needsReconciliation) {
    for (const position of Object.values(positions)) {
      if (position.pendingAction?.status === 'failed') position.pendingAction = null;
    }
  }
  return {
    version: 2,
    mode: 'BOT_PAPER',
    autoRun: false,
    liveArmedThisSession: false,
    needsReconciliation,
    pendingDecision: needsReconciliation ? pending : null,
    positions,
    closedPositions: Array.isArray(previous.closedPositions) ? previous.closedPositions.slice(-500) : [],
    candidates: migratedCandidates,
    lastClosedAtByMint: previous.lastClosedAtByMint && typeof previous.lastClosedAtByMint === 'object' ? previous.lastClosedAtByMint : {},
    seenWalletSignals: Array.isArray(previous.seenWalletSignals || previous.seenWalletSignatures) ? (previous.seenWalletSignals || previous.seenWalletSignatures).slice(-5000) : [],
    latestSignal: previous.latestSignal || null,
    latestDecision: previous.latestDecision || null,
    latestFill: previous.latestFill || null,
    latestFailure: previous.latestFailure || null,
    latestTransactionId: previous.latestTransactionId || null,
    liveReadiness: { ready: false, reason: 'Not checked this session.' },
    sessionStats: { walletSignals: 0, candidates: 0, paperBuys: 0, priceExpiries: 0, closed: 0 }
  };
}

class AutoBotEngine extends PaperEngine {
  constructor({ config, store = null, clock = () => Date.now(), trajectoryIndex, executionAdapters = {}, auditWriter = null, sessionId = null }) {
    super({ config, store, clock });
    this.state.bot = freshBotState(this.state.bot);
    for (const position of [...Object.values(this.state.bot.positions), ...this.state.bot.closedPositions]) {
      position.entryIndex ||= finite(position.entryPriceUsd);
      position.pricingUnit ||= 'USD_RATIO';
      position.fillQuality ||= 'EXECUTABLE_PRICE';
      position.highIndex ||= position.entryIndex;
      position.lowIndex ||= position.entryIndex;
      position.targetObservations ||= {};
    }
    this.state.followEnabled = false;
    this.consensus = new RollingConsensus({
      wallets: config.wallets,
      normalWindowMs: config.bot.normal.windowSeconds * 1000,
      strongWindowMs: config.bot.strong.windowSeconds * 1000,
      clock
    });
    this.walletWeights = new Map(config.wallets.filter((wallet) => wallet.enabled).map((wallet) => [wallet.address, Number(wallet.weight || 1)]));
    this.trajectoryIndex = trajectoryIndex;
    this.executionAdapters = executionAdapters;
    this.auditWriter = auditWriter;
    this.sessionId = sessionId || `session_${new Date(clock()).toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`;
    this.candles = new Map();
    this.marketPriorities = new Map();
    this.entryLocks = new Set();
    this.exitLocks = new Set();
    this.auditTimer = null;
    this._auditSessionStart();
    this._commit();
  }

  setExecutionAdapters(adapters) { this.executionAdapters = adapters; }
  _checkAutomations() {}

  startAutomation() {
    if (this.auditTimer) return;
    this.auditTimer = setInterval(() => void this.auditTick(), 500);
    this.auditTimer.unref?.();
  }

  stopAutomation() { clearInterval(this.auditTimer); this.auditTimer = null; }

  getActiveMints() {
    const monitoredClosed = this.state.bot.closedPositions.filter((position) => !position.outcomeComplete && this.clock() <= Number(position.outcomeEndsAt || 0)).map((position) => position.mint);
    return [...new Set([
      ...super.getActiveMints(),
      ...Object.keys(this.state.bot.positions),
      ...Object.values(this.state.bot.candidates).filter((candidate) => ['WAITING_PRICE', 'BOUGHT'].includes(candidate.state)).map((candidate) => candidate.mint),
      ...monitoredClosed
    ])];
  }

  _lifecycle(input = {}, market = null) {
    const supplied = String(input.lifecycleStage || input.tokenStage || input.status || '').toUpperCase().replaceAll('-', '_');
    if (['NEW_CREATION', 'NEAR_COMPLETION', 'MIGRATED', 'COMPLETED'].includes(supplied)) return supplied === 'COMPLETED' ? 'MIGRATED' : supplied;
    if (market?.nearGraduation) return 'NEAR_COMPLETION';
    if (market?.migrated) return 'MIGRATED';
    return 'NEW_CREATION';
  }

  _newCandidate(mint, input = {}) {
    const market = this.markets.get(mint) || null;
    const decisionId = this._id('decision');
    const candidate = {
      mint,
      symbol: String(input.symbol || market?.symbol || '').slice(0, 24),
      state: 'OBSERVED',
      lifecycleStage: this._lifecycle(input, market),
      firstSignalAt: finite(input.observedAt, this.clock()),
      lastSignalAt: finite(input.observedAt, this.clock()),
      sourceWallets: [], sourceSignatures: [], walletCount: 0, weightedConsensusPct: 0,
      priceAttempts: [], priceWaitStartedAt: null, nextPriceAttemptAt: null,
      priceSource: market?.source || null, priceAgeMs: market ? this.clock() - market.receivedAt : null,
      bondingPct: finite(input.bondingPct, market?.bondingPct ?? null),
      liquidityUsd: finite(input.liquidityUsd, market?.liquidityUsd ?? null),
      marketCapUsd: finite(input.marketCapUsd, market?.marketCapUsd ?? null),
      riskFlags: input.riskFlags || market?.riskFlags || {},
      security: input.security || market?.security || {},
      trajectory: this.trajectoryFor(mint),
      finalDecision: null, reason: 'Wallet activity observed.', decisionId, tradeId: `trade_${decisionId}`,
      updatedAt: this.clock()
    };
    this.state.bot.candidates[mint] = candidate;
    this.state.bot.sessionStats.candidates += 1;
    this._auditEvent('CANDIDATE_CREATED', { candidate, eventId: `candidate:${this.sessionId}:${mint}:${candidate.firstSignalAt}` });
    return candidate;
  }

  _candidate(mint, input = {}) { return this.state.bot.candidates[mint] || this._newCandidate(mint, input); }

  observeDiscovery({ mint, symbol = '', status, priceUsd = null, marketCapUsd = null, liquidityUsd = null, bondingPct = null, riskFlags = {} }) {
    if (!ADDRESS_RE.test(String(mint || ''))) return;
    const lifecycleStage = status === 'PRE-ARMED' ? 'NEAR_COMPLETION' : status === 'MIGRATED' ? 'MIGRATED' : 'NEW_CREATION';
    const candidate = this._candidate(mint, { symbol, lifecycleStage, marketCapUsd, liquidityUsd, bondingPct, riskFlags, observedAt: this.clock() });
    candidate.symbol = symbol || candidate.symbol;
    candidate.lifecycleStage = lifecycleStage;
    candidate.marketCapUsd = finite(marketCapUsd, candidate.marketCapUsd);
    candidate.liquidityUsd = finite(liquidityUsd, candidate.liquidityUsd);
    candidate.bondingPct = finite(bondingPct, candidate.bondingPct);
    candidate.riskFlags = riskFlags || candidate.riskFlags;
    candidate.updatedAt = this.clock();
    if (Number(priceUsd) > 0 || Number(marketCapUsd) > 0) this.setMarket({ mint, symbol, priceUsd, marketCapUsd, liquidityUsd, bondingPct, nearGraduation: lifecycleStage === 'NEAR_COMPLETION', migrated: lifecycleStage === 'MIGRATED', source: 'gmgn-trenches', observedAt: this.clock() });
    this.emit('update');
  }

  _sourcePriority(input) {
    const source = String(input.source || '').toLowerCase();
    const absolute = Number(input.priceUsd) > 0;
    const tier = source.includes('gmgn-network') || source.includes('gmgn-page') ? 1
      : source.includes('gmgn-cli') || source.includes('kline') ? 2
        : source.includes('dexscreener') ? 3
          : source.includes('trenches') ? 4 : 5;
    return (absolute ? 100 : 10) - tier;
  }

  setMarket(input) {
    const mint = String(input?.mint || '').trim();
    if (!ADDRESS_RE.test(mint) || (!(Number(input.priceUsd) > 0) && !(Number(input.marketCapUsd) > 0))) return { status: 'ignored', reason: 'invalid-market' };
    const priority = this._sourcePriority(input);
    const existing = this.markets.get(mint);
    const existingPriority = this.marketPriorities.get(mint) ?? -Infinity;
    const existingFresh = existing && this.clock() - existing.receivedAt <= this.config.paper.maxPriceAgeMs;
    if (existingFresh && existingPriority > priority) {
      for (const key of ['marketCapUsd', 'liquidityUsd', 'bondingPct']) if (finite(input[key]) != null) existing[key] = finite(input[key]);
      this._refreshCandidateMarket(mint, existing);
      return { status: 'accepted', market: existing, retainedHigherPrioritySource: true };
    }
    const result = super.setMarket(input);
    if (result.status !== 'accepted') return result;
    this.marketPriorities.set(mint, priority);
    const market = this.markets.get(mint);
    Object.assign(market, {
      liquidityUsd: finite(input.liquidityUsd, market.liquidityUsd ?? null),
      bondingPct: finite(input.bondingPct, market.bondingPct ?? null),
      migrated: input.migrated == null ? market.migrated ?? null : Boolean(input.migrated),
      nearGraduation: input.nearGraduation == null ? market.nearGraduation ?? false : Boolean(input.nearGraduation),
      routeable: input.routeable == null ? market.routeable ?? null : Boolean(input.routeable),
      honeypot: input.honeypot == null ? market.honeypot ?? null : Boolean(input.honeypot),
      securityFailed: input.securityFailed == null ? market.securityFailed ?? false : Boolean(input.securityFailed),
      sellQuoteAvailable: input.sellQuoteAvailable == null ? market.sellQuoteAvailable ?? true : Boolean(input.sellQuoteAvailable),
      quoteFeeSol: finite(input.quoteFeeSol, market.quoteFeeSol ?? 0),
      quoteSource: input.quoteSource || market.quoteSource || null,
      volumeUsd1m: finite(input.volumeUsd1m, market.volumeUsd1m ?? 0),
      riskFlags: input.riskFlags || market.riskFlags || {},
      security: input.security || market.security || {}
    });
    if (Array.isArray(input.trajectoryCandles)) this.candles.set(mint, input.trajectoryCandles.slice(-61));
    else if (market.priceUsd) this._captureCandle(market);
    this._refreshCandidateMarket(mint, market);
    this._observeMarketForPositions(mint, market);
    void this._evaluateExit(mint);
    if (this.state.bot.autoRun && this.state.bot.candidates[mint]?.state === 'WAITING_PRICE') void this._considerEntry(mint);
    this.emit('update');
    return { ...result, market };
  }

  _refreshCandidateMarket(mint, market) {
    const candidate = this.state.bot.candidates[mint];
    if (!candidate) return;
    candidate.symbol = market.symbol || candidate.symbol;
    candidate.priceSource = market.source;
    candidate.priceAgeMs = Math.max(0, this.clock() - market.receivedAt);
    candidate.bondingPct = finite(market.bondingPct, candidate.bondingPct);
    candidate.liquidityUsd = finite(market.liquidityUsd, candidate.liquidityUsd);
    candidate.marketCapUsd = finite(market.marketCapUsd, candidate.marketCapUsd);
    candidate.riskFlags = market.riskFlags || candidate.riskFlags;
    candidate.security = market.security || candidate.security;
    candidate.lifecycleStage = this._lifecycle({}, market);
    candidate.trajectory = this.trajectoryFor(mint);
    candidate.updatedAt = this.clock();
  }

  _captureCandle(market) {
    const list = this.candles.get(market.mint) || [];
    const minute = Math.floor(market.receivedAt / 60_000) * 60_000;
    const candle = { time: minute, close: market.priceUsd, volume: Number(market.volumeUsd1m || 0) };
    if (list.at(-1)?.time === minute) list[list.length - 1] = candle;
    else list.push(candle);
    this.candles.set(market.mint, list.slice(-61));
  }

  trajectoryFor(mint) { return this.trajectoryIndex?.match(this.candles.get(mint) || []) || { label: 'unavailable', confidence: 0, nearestMatches: [] }; }

  _botEvent(field, kind, message, data = {}) {
    const value = { at: this.clock(), kind, message, ...data };
    this.state.bot[field] = value;
    this._record(kind, message, data);
    return value;
  }

  async handleWalletSignal(input) {
    const side = String(input?.side || '').toLowerCase();
    const mint = String(input?.mint || '').trim();
    const wallet = String(input?.wallet || '').trim();
    if (!['buy', 'sell'].includes(side) || !ADDRESS_RE.test(mint) || !ADDRESS_RE.test(wallet)) return { status: 'ignored', reason: 'invalid-signal' };
    if (!this.walletWeights.has(wallet)) return { status: 'filtered', reason: 'wallet-not-enabled' };
    const signature = String(input.signature || input.id || '').trim();
    const dedupeKey = `${wallet}:${mint}:${signature || finite(input.observedAt, this.clock())}:${side}`;
    if (this.state.bot.seenWalletSignals.includes(dedupeKey)) return { status: 'duplicate', reason: 'duplicate-signature' };
    this.state.bot.seenWalletSignals.push(dedupeKey);
    this.state.bot.seenWalletSignals = this.state.bot.seenWalletSignals.slice(-5000);
    this.state.bot.sessionStats.walletSignals += 1;
    const signalAt = finite(input.observedAt, this.clock());
    let candidate = this.state.bot.candidates[mint];
    const terminal = candidate && ['REJECTED', 'EXPIRED', 'BOUGHT'].includes(candidate.state);
    const cooldownElapsed = this.clock() - Number(this.state.bot.lastClosedAtByMint[mint] || 0) >= this.config.bot.paperAggressive.reentryCooldownSeconds * 1000;
    if (terminal && !this.state.bot.positions[mint] && (candidate.state !== 'BOUGHT' || cooldownElapsed)) candidate = this._newCandidate(mint, { ...input, observedAt: signalAt });
    else candidate = candidate || this._newCandidate(mint, { ...input, observedAt: signalAt });
    candidate.lastSignalAt = Math.max(candidate.lastSignalAt || signalAt, signalAt);
    candidate.symbol = String(input.symbol || candidate.symbol || '').slice(0, 24);
    candidate.lifecycleStage = this._lifecycle(input, this.markets.get(mint));
    if (!candidate.sourceWallets.some((item) => item.address === wallet)) candidate.sourceWallets.push({ address: wallet, label: String(input.walletLabel || ''), weight: this.walletWeights.get(wallet), observedAt: signalAt });
    if (signature && !candidate.sourceSignatures.includes(signature)) candidate.sourceSignatures.push(signature);
    const consensusResult = side === 'buy' ? this.consensus.ingest({ mint, wallet, signature, observedAt: signalAt }) : null;
    const consensus = this.consensus.snapshot(mint);
    candidate.walletCount = consensus.normal.walletCount;
    candidate.weightedConsensusPct = consensus.normal.weightedConsensusPct;
    candidate.lastSignalSlot = input.slot ?? candidate.lastSignalSlot ?? null;
    candidate.lastSignalCommitment = input.commitment || candidate.lastSignalCommitment || 'processed';
    candidate.detectionLatencyMs = input.detectionLatencyMs ?? candidate.detectionLatencyMs ?? null;
    if (this.state.bot.positions[mint]) this.state.bot.positions[mint].maximumConsensusPct = Math.max(
      Number(this.state.bot.positions[mint].maximumConsensusPct || 0),
      Number(consensus.normal.weightedConsensusPct || 0)
    );
    candidate.updatedAt = this.clock();
    this._botEvent('latestSignal', 'wallet-signal', `${side.toUpperCase()} from ${wallet.slice(0, 5)}…`, { mint, wallet, side, signature });
    this._auditEvent(side === 'buy' ? 'WALLET_BUY' : 'WALLET_SELL', {
      candidate, sourceWallet: wallet, sourceSignature: signature, walletWeight: this.walletWeights.get(wallet),
      eventId: `signal:${dedupeKey}`,
      detectionToDecisionMs: input.detectionLatencyMs,
      notes: {
        notificationAt: input.notificationAt || null,
        transactionFetchedAt: input.transactionFetchedAt || null,
        classificationAt: input.classificationAt || null,
        detectionLatencyMs: input.detectionLatencyMs ?? null,
        commitment: input.commitment || 'processed',
        slot: input.slot ?? null
      }
    });
    if (side === 'sell') { this._commit(); return { status: 'observed', reason: 'wallet-sells-do-not-control-exits' }; }
    if (consensusResult?.status === 'filtered') { this._commit(); return consensusResult; }
    if (!this.state.bot.autoRun) {
      candidate.reason = 'AUTO paused.';
      this._commit();
      return { status: 'observed', reason: 'auto-paused', consensus };
    }
    this._commit();
    return this._considerEntry(mint, signalAt);
  }

  _thresholdPath(consensus) {
    const strong = consensus.strong.walletCount >= this.config.bot.strong.walletCount && consensus.strong.weightedConsensusPct >= this.config.bot.strong.weightedConsensusPct;
    const normal = consensus.normal.walletCount >= this.config.bot.normal.walletCount && consensus.normal.weightedConsensusPct >= this.config.bot.normal.weightedConsensusPct;
    return strong ? 'strong' : normal ? 'normal' : null;
  }

  _liveEntryGate(mint, trajectory, path) {
    const market = this._freshMarket(mint);
    if (!path) return 'wallet consensus below configured BOT_LIVE threshold';
    if (!ADDRESS_RE.test(mint)) return 'invalid Solana mint';
    if (this.state.bot.positions[mint] || this.state.lots.some((lot) => lot.mint === mint)) return 'position already active';
    if (Object.values(this.state.bot.positions).filter((position) => position.mode === 'BOT_LIVE').length >= this.config.bot.maxOpenPositions) return 'open-position limit reached';
    if (!market?.priceUsd) return 'fresh absolute price/quote unavailable';
    if (market.nearGraduation && !market.migrated) return 'PRE-ARMED: waiting for confirmed migration';
    if (market.migrated !== true) return 'migration not confirmed';
    if (market.routeable !== true) return 'fresh routeable quote unavailable';
    if (!(market.liquidityUsd >= this.config.bot.minimumLiquidityUsd)) return `liquidity below $${this.config.bot.minimumLiquidityUsd}`;
    if (market.honeypot === true || market.securityFailed === true) return 'positive security/honeypot failure';
    if (trajectory.label === 'adverse' && trajectory.confidence >= this.config.bot.adverseHistoryVetoConfidence) return 'high-confidence adverse trajectory veto';
    if (trajectory.label === 'unavailable' && path !== 'strong') return 'history unavailable: strong wallet consensus required';
    return null;
  }

  _paperHardBlocker(mint) {
    if (!ADDRESS_RE.test(mint)) return 'invalid Solana mint';
    if (this.state.bot.positions[mint] || this.state.lots.some((lot) => lot.mint === mint)) return 'position already open for mint';
    const openPaper = Object.values(this.state.bot.positions).filter((position) => position.mode === 'BOT_PAPER').length;
    if (openPaper >= this.config.bot.paperAggressive.maxOpenPositions) return 'maximum open paper positions reached';
    const closedAt = Number(this.state.bot.lastClosedAtByMint[mint] || 0);
    if (closedAt && this.clock() - closedAt < this.config.bot.paperAggressive.reentryCooldownSeconds * 1000) return `re-entry cooldown ${Math.ceil((this.config.bot.paperAggressive.reentryCooldownSeconds * 1000 - (this.clock() - closedAt)) / 1000)}s`;
    if (this.state.balanceSol < this.config.bot.paperAggressive.orderSol + this.config.paper.networkFeeSol + this.config.paper.priorityFeeSol) return 'insufficient paper balance';
    return null;
  }

  _queuePrice(candidate) {
    const now = this.clock();
    if (!candidate.priceWaitStartedAt) candidate.priceWaitStartedAt = now;
    candidate.state = 'WAITING_PRICE';
    candidate.reason = `WAITING FOR PRICE — ${Math.floor((now - candidate.priceWaitStartedAt) / 1000)}s / ${this.config.bot.paperAggressive.priceWaitTimeoutSeconds}s`;
    if (!candidate.nextPriceAttemptAt || now >= candidate.nextPriceAttemptAt) {
      const attempt = { at: now, sources: ['GMGN_PAGE_NETWORK', 'GMGN_MARKET_KLINE', 'DEX_SCREENER', 'TRENCHES', 'MARKET_CAP_RATIO'] };
      candidate.priceAttempts.push(attempt);
      candidate.priceAttempts = candidate.priceAttempts.slice(-25);
      candidate.nextPriceAttemptAt = now + this.config.bot.paperAggressive.priceRetryMs;
      this._auditEvent('PRICE_ATTEMPT', { candidate, eventId: `price-attempt:${this.sessionId}:${candidate.mint}:${now}`, notes: attempt.sources.join(' > ') });
    }
    this._commit();
    return { status: 'awaiting-price', reason: candidate.reason };
  }

  async _considerEntry(mint, signalObservedAt = null) {
    if (!this.state.bot.autoRun || this.entryLocks.has(mint) || this.state.bot.positions[mint]) return { status: 'observed' };
    const candidate = this._candidate(mint);
    const consensus = this.consensus.snapshot(mint);
    candidate.walletCount = consensus.normal.walletCount;
    candidate.weightedConsensusPct = consensus.normal.weightedConsensusPct;
    candidate.trajectory = this.trajectoryFor(mint);
    const paperMode = this.state.bot.mode === 'BOT_PAPER';
    const path = paperMode ? 'single-wallet-paper' : this._thresholdPath(consensus);
    const rejection = paperMode ? this._paperHardBlocker(mint) : this._liveEntryGate(mint, candidate.trajectory, path);
    if (rejection) {
      candidate.state = 'REJECTED';
      candidate.finalDecision = 'REJECTED'; candidate.reason = rejection;
      this._botEvent('latestDecision', 'entry-rejected', rejection, { mint, path });
      this._auditEvent('REJECTED', { candidate, rejectionReason: rejection, eventId: `rejected:${this.sessionId}:${mint}:${this.clock()}` });
      this._commit();
      return { status: 'rejected', reason: rejection };
    }
    const market = this._freshMarket(mint);
    if (paperMode && (!market || (!(market.priceUsd > 0) && !(market.marketCapUsd > 0)))) return this._queuePrice(candidate);
    this.entryLocks.add(mint);
    try {
      if (this.config.paper.detectionToDecisionMs > 0) await wait(this.config.paper.detectionToDecisionMs);
      const adapter = this.executionAdapters[this.state.bot.mode];
      if (!adapter) throw new Error(`No execution adapter for ${this.state.bot.mode}`);
      const amountSol = paperMode ? this.config.bot.paperAggressive.orderSol : this.config.bot.orderSol;
      const quote = await adapter.quote({ mint, side: 'buy', amountSol });
      if (!quote.ok || (!paperMode && !quote.routeable)) {
        if (paperMode) return this._queuePrice(candidate);
        throw new Error(quote.reason || 'fresh routeable quote unavailable');
      }
      if (candidate.state === 'WAITING_PRICE') this._auditEvent('PRICE_READY', { candidate, eventId: `price-ready:${this.sessionId}:${mint}:${market.receivedAt}` });
      const decision = {
        id: candidate.decisionId || this._id('decision'), action: 'buy', mode: this.state.bot.mode, mint, path, consensus,
        trajectory: candidate.trajectory, quote, signalObservedAt: finite(signalObservedAt, candidate.firstSignalAt),
        decidedAt: this.clock(), status: 'pending-submission'
      };
      candidate.decisionId = decision.id;
      candidate.finalDecision = 'BUY';
      candidate.reason = paperMode ? 'One enabled candidate-wallet BUY; aggressive paper entry.' : `${path} wallet consensus with ${candidate.trajectory.label} history`;
      this.state.bot.pendingDecision = decision;
      this._botEvent('latestDecision', 'entry-decision', `BUY approved via ${path}`, { mint, decisionId: decision.id });
      this._commit();
      const result = await adapter.buy({ mint, amountSol, symbol: this.markets.get(mint)?.symbol || candidate.symbol, decision });
      if (!result.confirmed) return this._uncertainExecution(decision, result);
      const fill = result.fill || {};
      const entryIndex = Number(result.executionPriceUsd || fill.executionPriceOrIndex || quote.indexValue || market.priceUsd || market.marketCapUsd);
      const position = {
        mint, symbol: this.markets.get(mint)?.symbol || candidate.symbol, mode: this.state.bot.mode,
        tradeId: candidate.tradeId || `trade_${decision.id}`, decisionId: decision.id, sessionId: this.sessionId,
        lifecycleStage: candidate.lifecycleStage, stage: 'BEFORE_TP1', entryAt: this.clock(),
        entrySignalAt: decision.signalObservedAt, decisionAt: decision.decidedAt,
        entryPriceUsd: fill.executionPriceUsd || result.executionPriceUsd || null, entryIndex,
        pricingUnit: fill.pricingUnit || quote.pricingUnit || 'USD_RATIO',
        fillQuality: fill.fillQuality || quote.fillQuality || 'EXECUTABLE_PRICE',
        highIndex: entryIndex, lowIndex: entryIndex, entryLiquidityUsd: market.liquidityUsd || null,
        entryMarketCapUsd: market.marketCapUsd || null, entryBondingPct: market.bondingPct || null,
        entryRiskFlags: market.riskFlags || {}, trajectory: candidate.trajectory,
        initialAmountSol: amountSol, remainingPct: 100, transactionId: result.transactionId || null,
        tp1Complete: false, counterfactual2x: false, counterfactual4x: false,
        targetObservations: {}, pendingAction: null, realizedPnlSol: 0, grossProceedsSol: 0,
        netProceedsSol: 0, modeledFeesSol: Number(fill.feesSol || 0), modeledSlippageSol: Number(fill.modeledSlippageSol || 0),
        mfePct: 0, maePct: 0, maximumConsensusPct: candidate.weightedConsensusPct,
        lastOpenSampleAt: this.clock(), lastOutcomeSampleAt: null,
        outcomeEndsAt: this.clock() + this.config.bot.paperAggressive.outcomeWindowMinutes * 60_000,
        outcomeComplete: false,
        sourceWallets: candidate.sourceWallets, sourceSignatures: candidate.sourceSignatures,
        entryReason: candidate.reason, entryFillId: fill.id || result.transactionId || decision.id
      };
      candidate.state = 'BOUGHT'; candidate.tradeId = position.tradeId; candidate.updatedAt = this.clock();
      this.state.bot.positions[mint] = position;
      this.state.bot.pendingDecision = null;
      this.state.bot.latestTransactionId = result.transactionId || null;
      if (paperMode) this.state.bot.sessionStats.paperBuys += 1;
      this._botEvent('latestFill', 'entry-fill', 'PAPER BUY FILLED', { mint, transactionId: result.transactionId || null, priceOrIndex: entryIndex, fillQuality: position.fillQuality });
      this._auditEvent('PAPER_BUY', {
        candidate, position, fill, decision, eventId: `fill:${position.entryFillId}`,
        detectionToDecisionMs: Math.max(0, decision.decidedAt - decision.signalObservedAt),
        decisionToFillMs: Math.max(0, position.entryAt - decision.decidedAt)
      });
      this._commit();
      return { status: 'filled', position, result };
    } catch (error) {
      if (this.state.bot.pendingDecision) this.state.bot.pendingDecision.status = 'failed-before-confirmation';
      this.state.bot.pendingDecision = null;
      candidate.state = 'REJECTED'; candidate.finalDecision = 'REJECTED'; candidate.reason = error.message;
      this._botEvent('latestFailure', 'entry-failure', error.message, { mint });
      this._auditEvent('REJECTED', { candidate, rejectionReason: error.message, eventId: `rejected:${this.sessionId}:${mint}:${this.clock()}` });
      this._commit();
      return { status: 'failed', reason: error.message };
    } finally { this.entryLocks.delete(mint); }
  }

  _marketIndex(position, market) {
    if (!market) return null;
    if (position.pricingUnit === 'MARKET_CAP_RATIO') return finite(market.marketCapUsd);
    return finite(market.priceUsd);
  }

  _exitReason(position, market) {
    const current = this._marketIndex(position, market);
    if (!(current > 0) || !(position.entryIndex > 0)) return null;
    const ratio = current / position.entryIndex;
    const ageMs = this.clock() - position.entryAt;
    const collapsed = market.liquidityUsd != null && position.entryLiquidityUsd != null && market.liquidityUsd < Math.max(this.config.bot.liquidityCollapseFloorUsd, position.entryLiquidityUsd * this.config.bot.liquidityCollapseRatio);
    if (collapsed) return { reason: 'liquidity-collapse', percent: 100, final: true };
    if (market.sellQuoteAvailable === false && position.mode === 'BOT_LIVE') return { reason: 'sell-quote-unavailable', percent: 100, final: true };
    if (!position.tp1Complete) {
      if (ratio <= 1 - this.config.bot.exit.hardStopPct / 100) return { reason: 'hard-stop', percent: 100, final: true };
      if (ageMs >= this.config.bot.exit.maxHoldBeforeTp1Minutes * 60_000) return { reason: 'max-hold-before-tp1', percent: 100, final: true };
      if (ratio >= 1 + this.config.bot.exit.tp1Pct / 100) return { reason: 'tp1', percent: 50, final: false };
      return null;
    }
    if (ratio >= 1 + this.config.bot.exit.finalTakeProfitPct / 100) return { reason: 'final-take-profit', percent: 100, final: true };
    const trailingStop = Math.max(position.entryIndex, position.highIndex * (1 - this.config.bot.exit.trailingStopPct / 100));
    if (current <= trailingStop) return { reason: 'trailing-stop', percent: 100, final: true };
    if (ageMs >= this.config.bot.exit.maxTotalHoldMinutes * 60_000) return { reason: 'max-total-hold', percent: 100, final: true };
    return null;
  }

  _observeMarketForPositions(mint, market) {
    for (const position of [...Object.values(this.state.bot.positions), ...this.state.bot.closedPositions]) {
      if (position.mint !== mint || position.outcomeComplete) continue;
      const current = this._marketIndex(position, market);
      if (!(current > 0) || !(position.entryIndex > 0)) continue;
      const ratio = current / position.entryIndex;
      if (!position.exitAt) {
        position.highIndex = Math.max(position.highIndex || current, current);
        position.lowIndex = Math.min(position.lowIndex || current, current);
        position.mfePct = Math.max(position.mfePct || 0, (ratio - 1) * 100);
        position.maePct = Math.min(position.maePct || 0, (ratio - 1) * 100);
        position.maximumConsensusPct = Math.max(position.maximumConsensusPct || 0, this.consensus.snapshot(mint).normal.weightedConsensusPct);
      }
      const targets = [['PLUS_15', 1.15, 'gte'], ['PLUS_50', 1.5, 'gte'], ['2X', 2, 'gte'], ['4X', 4, 'gte'], ['MINUS_25', 0.75, 'lte'], ['MINUS_50', 0.5, 'lte'], ['MINUS_90', 0.1, 'lte']];
      for (const [name, threshold, direction] of targets) {
        const hit = direction === 'gte' ? ratio >= threshold : ratio <= threshold;
        if (!hit || position.targetObservations?.[name]) continue;
        position.targetObservations ||= {};
        position.targetObservations[name] = { at: this.clock(), ratio, beforeExit: !position.exitAt };
        if (name === '2X') position.counterfactual2x = true;
        if (name === '4X') position.counterfactual4x = true;
        this._auditEvent('COUNTERFACTUAL_TARGET', { position, eventId: `target:${position.tradeId}:${name}`, notes: name });
      }
    }
  }

  async _evaluateExit(mint) {
    const position = this.state.bot.positions[mint];
    const market = this._freshMarket(mint);
    if (!position || !market || position.pendingAction || this.exitLocks.has(mint) || this.clock() < Number(position.nextExitRetryAt || 0)) return;
    const action = this._exitReason(position, market);
    if (!action || !this.state.bot.autoRun) return;
    this.exitLocks.add(mint);
    const adapter = this.executionAdapters[position.mode];
    const decision = { id: this._id('decision'), action: 'sell', mint, ...action, decidedAt: this.clock(), status: 'pending-submission' };
    position.pendingAction = decision;
    this.state.bot.pendingDecision = decision;
    this._botEvent('latestDecision', 'exit-decision', `${action.reason}: sell ${action.percent}%`, { mint, decisionId: decision.id });
    this._commit();
    try {
      const quote = await adapter.quote({ mint, side: 'sell', percent: action.percent });
      decision.quote = quote;
      if ((!quote.ok || !quote.routeable) && position.mode === 'BOT_LIVE') return this._uncertainExecution(decision, { uncertain: true, reason: quote.reason || 'sell quote unavailable' });
      if ((!quote.ok || !quote.routeable) && adapter.client) {
        position.pendingAction = null;
        position.routeStatus = 'UNSELLABLE/NO_ROUTE';
        position.nextExitRetryAt = this.clock() + 10_000;
        this.state.bot.pendingDecision = null;
        this._botEvent('latestFailure', 'paper-exit-no-route', quote.reason || 'No fresh reverse route; paper position remains open.', { mint, decisionId: decision.id });
        this._commit();
        return { status: 'no-route', reason: quote.reason || 'no-fresh-reverse-route' };
      }
      const result = await adapter.sellPercent({ mint, percent: action.percent, reason: action.reason, decision });
      if (!result.confirmed && position.mode === 'BOT_PAPER' && adapter.client && !result.uncertain) {
        position.pendingAction = null;
        position.routeStatus = 'UNSELLABLE/NO_ROUTE';
        position.nextExitRetryAt = this.clock() + 10_000;
        this.state.bot.pendingDecision = null;
        this._botEvent('latestFailure', 'paper-exit-failed', result.reason || 'Paper exit was not confirmed; position remains open.', { mint, decisionId: decision.id });
        this._commit();
        return { status: result.status || 'failed', reason: result.reason || 'paper-exit-not-confirmed' };
      }
      if (!result.confirmed) return this._uncertainExecution(decision, result);
      const fill = result.fill || {};
      const current = Number(fill.executionPriceOrIndex || result.executionPriceUsd || this._marketIndex(position, market));
      position.pendingAction = null;
      this.state.bot.pendingDecision = null;
      this.state.bot.latestTransactionId = result.transactionId || null;
      const exitPnl = Number(fill.realizedPnlSol ?? 0);
      position.realizedPnlSol += exitPnl;
      position.grossProceedsSol += Number(fill.amountSol || result.proceedsSol || 0);
      position.netProceedsSol += Number(fill.netProceedsSol || result.proceedsSol || 0);
      position.modeledFeesSol += Number(fill.feesSol || result.feesSol || 0);
      position.modeledSlippageSol += Number(fill.modeledSlippageSol || 0);
      const eventType = action.reason === 'tp1' ? 'TP1_SELL'
        : ['hard-stop', 'trailing-stop', 'liquidity-collapse', 'sell-quote-unavailable'].includes(action.reason) ? 'STOP_SELL'
          : ['max-hold-before-tp1', 'max-total-hold'].includes(action.reason) ? 'TIME_EXIT' : 'FINAL_SELL';
      if (action.final) {
        position.stage = 'CLOSED'; position.exitAt = this.clock(); position.exitIndex = current;
        position.lastOutcomeSampleAt = position.exitAt;
        position.exitReason = action.reason; position.exitTransactionId = result.transactionId || null;
        position.remainingPct = 0;
        this.state.bot.closedPositions.push(position);
        this.state.bot.closedPositions = this.state.bot.closedPositions.slice(-500);
        delete this.state.bot.positions[mint];
        this.state.bot.lastClosedAtByMint[mint] = this.clock();
        this.state.bot.sessionStats.closed += 1;
        this._writeTrade(position);
      } else {
        position.tp1Complete = true; position.stage = 'AFTER_TP1'; position.remainingPct = 50;
        position.stopIndex = position.entryIndex; position.tp1At = this.clock(); position.tp1Index = current;
        position.tp1TransactionId = result.transactionId || null;
      }
      this._botEvent('latestFill', 'exit-fill', action.reason === 'tp1' ? 'TP1 — 50% SOLD' : 'PAPER POSITION CLOSED', { mint, percent: action.percent, transactionId: result.transactionId || null });
      this._auditEvent(eventType, { position, fill, decision, eventId: `fill:${fill.id || result.transactionId || decision.id}` });
      this._commit();
      return result;
    } catch (error) { return this._uncertainExecution(decision, { uncertain: true, reason: error.message }); }
    finally { this.exitLocks.delete(mint); }
  }

  _uncertainExecution(decision, result) {
    decision.status = result.uncertain ? 'uncertain-reconcile-required' : 'failed';
    decision.result = { status: result.status || null, orderId: result.orderId || result.order_id || null, reason: result.reason || result.error_status || null };
    this.state.bot.autoRun = false;
    this.state.bot.needsReconciliation = true;
    this._botEvent('latestFailure', 'execution-uncertain', result.reason || result.error_status || 'Order not confirmed; AUTO paused for reconciliation.', { mint: decision.mint, decisionId: decision.id });
    this._commit();
    return { status: 'paused-reconcile', ...result };
  }

  async auditTick() {
    const now = this.clock();
    for (const candidate of Object.values(this.state.bot.candidates)) {
      if (candidate.state !== 'WAITING_PRICE') continue;
      const elapsed = now - candidate.priceWaitStartedAt;
      if (elapsed >= this.config.bot.paperAggressive.priceWaitTimeoutSeconds * 1000) {
        candidate.state = 'EXPIRED'; candidate.finalDecision = 'EXPIRED'; candidate.reason = 'No usable price or market-cap index within 20 seconds.';
        this.state.bot.sessionStats.priceExpiries += 1;
        this._auditEvent('EXPIRED', { candidate, rejectionReason: candidate.reason, eventId: `expired:${this.sessionId}:${candidate.mint}:${candidate.priceWaitStartedAt}` });
        this._commit();
      } else if (now >= Number(candidate.nextPriceAttemptAt || 0)) {
        this._queuePrice(candidate);
        if (this._freshMarket(candidate.mint)) await this._considerEntry(candidate.mint);
      } else {
        candidate.reason = `WAITING FOR PRICE — ${Math.floor(elapsed / 1000)}s / ${this.config.bot.paperAggressive.priceWaitTimeoutSeconds}s`;
      }
    }
    for (const position of Object.values(this.state.bot.positions)) {
      if (now - Number(position.lastOpenSampleAt || 0) < this.config.bot.paperAggressive.openSampleMs) continue;
      position.lastOpenSampleAt = now;
      this._auditEvent('POSITION_SAMPLE', { position, eventId: `sample:${position.tradeId}:open:${Math.floor(now / this.config.bot.paperAggressive.openSampleMs)}` });
    }
    for (const position of this.state.bot.closedPositions) {
      if (position.outcomeComplete || !position.exitAt) continue;
      if (now >= position.outcomeEndsAt) {
        position.outcomeComplete = true;
        this._auditEvent('OUTCOME_60M', { position, eventId: `outcome:${position.tradeId}`, notes: position.targetObservations });
        this._commit();
      } else if (now - Number(position.lastOutcomeSampleAt || 0) >= this.config.bot.paperAggressive.outcomeSampleMs) {
        position.lastOutcomeSampleAt = now;
        this._auditEvent('POSITION_SAMPLE', { position, eventId: `sample:${position.tradeId}:outcome:${Math.floor(now / this.config.bot.paperAggressive.outcomeSampleMs)}`, notes: 'POST_EXIT_60M' });
      }
    }
  }

  _auditSessionStart() {
    const p = this.config.bot.paperAggressive;
    const e = this.config.bot.exit;
    this._auditEvent('SESSION_START', {
      eventId: `session-start:${this.sessionId}`,
      notes: {
        paper_order_sol: p.orderSol, maximum_positions: p.maxOpenPositions, hard_stop_pct: e.hardStopPct,
        tp1_pct: e.tp1Pct, tp2_pct: e.finalTakeProfitPct, trailing_pct: e.trailingStopPct,
        max_hold_before_tp1_minutes: e.maxHoldBeforeTp1Minutes, max_total_hold_minutes: e.maxTotalHoldMinutes,
        slippage_bps: this.config.paper.slippageBps, platform_fee_bps: this.config.paper.platformFeeBps,
        network_fee_sol: this.config.paper.networkFeeSol, priority_fee_sol: this.config.paper.priorityFeeSol
      }
    });
  }

  _auditEvent(eventType, context = {}) {
    if (!this.auditWriter) return { written: false };
    const candidate = context.candidate || this.state.bot.candidates[context.position?.mint || ''] || {};
    const position = context.position || this.state.bot.positions[candidate.mint] || {};
    const market = this.markets.get(candidate.mint || position.mint) || {};
    const fill = context.fill || {};
    const currentIndex = position.mint ? this._marketIndex(position, market) : market.priceUsd || market.marketCapUsd;
    const pnlPct = position.entryIndex && currentIndex ? (currentIndex / position.entryIndex - 1) * 100 : null;
    const row = {
      strategy_version: this.config.bot.paperAggressive.strategyVersion,
      session_id: this.sessionId, event_id: context.eventId || `audit:${this._id('event')}`,
      decision_id: context.decision?.id || position.decisionId || candidate.decisionId || '',
      trade_id: position.tradeId || candidate.tradeId || '', timestamp_utc: iso(this.clock()), event_type: eventType,
      mint: candidate.mint || position.mint || '', symbol: candidate.symbol || position.symbol || '',
      lifecycle_stage: candidate.lifecycleStage || position.lifecycleStage || '',
      source_wallet: context.sourceWallet || candidate.sourceWallets?.[0]?.address || '',
      source_signature: context.sourceSignature || candidate.sourceSignatures?.[0] || '',
      wallet_weight: context.walletWeight ?? candidate.sourceWallets?.[0]?.weight ?? '',
      wallet_count: candidate.walletCount ?? position.sourceWallets?.length ?? '',
      consensus_pct: candidate.weightedConsensusPct ?? position.maximumConsensusPct ?? '',
      candidate_state: candidate.state || '', decision: candidate.finalDecision || context.decision?.action || '',
      rejection_reason: context.rejectionReason || (candidate.state === 'REJECTED' || candidate.state === 'EXPIRED' ? candidate.reason : ''),
      bonding_pct: candidate.bondingPct ?? position.entryBondingPct ?? market.bondingPct ?? '',
      market_cap_usd: market.marketCapUsd ?? candidate.marketCapUsd ?? position.entryMarketCapUsd ?? '',
      liquidity_usd: market.liquidityUsd ?? candidate.liquidityUsd ?? position.entryLiquidityUsd ?? '',
      risk_flags: candidate.riskFlags || position.entryRiskFlags || {},
      trajectory_label: candidate.trajectory?.label || position.trajectory?.label || '',
      trajectory_confidence: candidate.trajectory?.confidence ?? position.trajectory?.confidence ?? '',
      price_source: market.source || candidate.priceSource || '', fill_quality: position.fillQuality || fill.fillQuality || '',
      pricing_unit: position.pricingUnit || fill.pricingUnit || '',
      observed_price_or_index: fill.observedPriceOrIndex ?? currentIndex ?? '',
      execution_price_or_index: fill.executionPriceOrIndex ?? position.entryIndex ?? '',
      price_age_ms: market.receivedAt ? Math.max(0, this.clock() - market.receivedAt) : '',
      position_stage: position.stage || '', amount_sol: position.initialAmountSol ?? fill.amountSol ?? '',
      entry_value: position.entryIndex ?? '', current_value: currentIndex ?? '', pnl_sol: position.realizedPnlSol ?? '',
      pnl_pct: pnlPct ?? '', mfe_pct: position.mfePct ?? '', mae_pct: position.maePct ?? '',
      hold_ms: position.entryAt ? this.clock() - position.entryAt : '', tp1_hit: Boolean(position.tp1Complete),
      exit_reason: position.exitReason || context.decision?.reason || '',
      detection_to_decision_ms: context.detectionToDecisionMs ?? '', decision_to_fill_ms: context.decisionToFillMs ?? '',
      modeled_fees_sol: fill.feesSol ?? position.modeledFeesSol ?? '', modeled_slippage_sol: fill.modeledSlippageSol ?? position.modeledSlippageSol ?? '',
      notes: context.notes || ''
    };
    return context.queued && this.auditWriter.queueEvent
      ? this.auditWriter.queueEvent(row)
      : this.auditWriter.writeEvent(row);
  }

  _writeTrade(position) {
    if (!this.auditWriter || position.mode !== 'BOT_PAPER') return;
    const targets = position.targetObservations || {};
    const platformFee = position.initialAmountSol * this.config.paper.platformFeeBps / 10_000;
    this.auditWriter.writeTrade({
      strategy_version: this.config.bot.paperAggressive.strategyVersion, session_id: position.sessionId || this.sessionId,
      trade_id: position.tradeId, decision_id: position.decisionId, mint: position.mint, symbol: position.symbol,
      lifecycle_stage_at_entry: position.lifecycleStage, source_wallets: position.sourceWallets?.map((item) => item.address).join('|') || '',
      source_signatures: position.sourceSignatures?.join('|') || '', wallet_count: position.sourceWallets?.length || 0,
      entry_consensus_pct: this.state.bot.candidates[position.mint]?.weightedConsensusPct || 0,
      primary_wallet_weight: position.sourceWallets?.[0]?.weight || '', entry_reason: position.entryReason,
      fill_quality: position.fillQuality, pricing_unit: position.pricingUnit,
      entry_signal_timestamp_utc: iso(position.entrySignalAt), decision_timestamp_utc: iso(position.decisionAt),
      entry_fill_timestamp_utc: iso(position.entryAt), entry_latency_ms: position.entryAt - position.entrySignalAt,
      amount_invested_sol: position.initialAmountSol, entry_price_or_index: position.entryIndex,
      tp1_timestamp_utc: iso(position.tp1At), tp1_price_or_index: position.tp1Index || '',
      final_exit_timestamp_utc: iso(position.exitAt), final_exit_price_or_index: position.exitIndex,
      exit_reason: position.exitReason, total_hold_ms: position.exitAt - position.entryAt,
      gross_proceeds_sol: position.grossProceedsSol, modeled_slippage_sol: position.modeledSlippageSol,
      platform_fee_sol: platformFee, network_fee_sol: this.config.paper.networkFeeSol,
      priority_fee_sol: this.config.paper.priorityFeeSol, total_modeled_fees_sol: position.modeledFeesSol,
      net_proceeds_sol: position.netProceedsSol, realized_net_pnl_sol: position.realizedPnlSol,
      realized_net_pnl_pct: position.initialAmountSol ? position.realizedPnlSol / position.initialAmountSol * 100 : 0,
      mfe_pct: position.mfePct, mae_pct: position.maePct, maximum_consensus_pct_after_entry: position.maximumConsensusPct,
      bonding_pct_at_entry: position.entryBondingPct ?? '', liquidity_usd_at_entry: position.entryLiquidityUsd ?? '',
      market_cap_usd_at_entry: position.entryMarketCapUsd ?? '', risk_flags: position.entryRiskFlags || {},
      trajectory_label: position.trajectory?.label || '', trajectory_confidence: position.trajectory?.confidence ?? '',
      observed_plus_15_before_exit: Boolean(targets.PLUS_15?.beforeExit), observed_plus_50_before_exit: Boolean(targets.PLUS_50?.beforeExit),
      observed_2x_before_exit: Boolean(targets['2X']?.beforeExit), observed_4x_before_exit: Boolean(targets['4X']?.beforeExit),
      used_executable_price: position.fillQuality === 'EXECUTABLE_PRICE', used_proxy_index: position.fillQuality === 'PROXY_ONLY', notes: ''
    });
  }

  setAutoRun(enabled) {
    const value = Boolean(enabled);
    if (value && this.state.bot.mode === 'BOT_LIVE' && (!this.state.bot.liveArmedThisSession || !this.state.bot.liveReadiness.ready)) return { status: 'blocked', reason: 'BOT_LIVE is not armed and ready.' };
    if (value && this.state.bot.needsReconciliation) return { status: 'blocked', reason: 'Reconciliation is required before AUTO can run.' };
    this.state.bot.autoRun = value;
    this._record('auto', `AUTO ${value ? 'RUN' : 'PAUSE'}`);
    this._commit();
    return { status: 'ok', autoRun: value };
  }

  setMode(mode, { confirmation = '', readiness = null } = {}) {
    if (!['BOT_PAPER', 'BOT_LIVE'].includes(mode)) return { status: 'ignored', reason: 'invalid-mode' };
    if (mode === 'BOT_LIVE') {
      if (!this.state.bot.liveArmedThisSession && confirmation !== 'LIVE') return { status: 'blocked', reason: 'Type LIVE once for this server session.' };
      if (!readiness?.ready) return { status: 'blocked', reason: readiness?.reason || 'GMGN live readiness failed.' };
      this.state.bot.liveArmedThisSession = true; this.state.bot.liveReadiness = readiness;
    }
    this.state.bot.autoRun = false; this.state.bot.mode = mode;
    this._record('mode', `${mode} selected; AUTO remains paused.`); this._commit();
    return { status: 'ok', mode, autoRun: false };
  }

  setLiveReadiness(readiness) { this.state.bot.liveReadiness = readiness; this.emit('update'); }

  async reconcile() {
    const result = await this.executionAdapters.BOT_LIVE.reconcilePositions();
    this.state.bot.needsReconciliation = false; this.state.bot.pendingDecision = null;
    for (const position of Object.values(this.state.bot.positions)) position.pendingAction = null;
    this._record('reconcile', 'Linked GMGN positions reconciled; AUTO remains paused.'); this._commit();
    return { status: 'ok', positions: result.positions };
  }

  reset() { super.reset(); this.state.bot = freshBotState(); this._commit(); return { status: 'ok' }; }

  _positionSnapshot(position) {
    const market = this.markets.get(position.mint);
    const currentIndex = this._marketIndex(position, market);
    const ratio = currentIndex && position.entryIndex ? currentIndex / position.entryIndex : 1;
    const remainingCost = position.initialAmountSol * position.remainingPct / 100;
    const unrealized = remainingCost * (ratio - 1);
    const trailingStop = position.tp1Complete ? Math.max(position.entryIndex, position.highIndex * (1 - this.config.bot.exit.trailingStopPct / 100)) : position.entryIndex * (1 - this.config.bot.exit.hardStopPct / 100);
    return {
      ...position, currentIndex, currentValueSol: remainingCost * ratio, unrealizedPnlSol: unrealized,
      pnlPct: (ratio - 1) * 100,
      holdMs: this.clock() - position.entryAt, priceSource: market?.source || null,
      priceAgeMs: market ? Math.max(0, this.clock() - market.receivedAt) : null,
      distanceToStopPct: currentIndex ? (currentIndex / trailingStop - 1) * 100 : null,
      distanceToTp1Pct: !position.tp1Complete && currentIndex ? (position.entryIndex * 1.15 / currentIndex - 1) * 100 : null,
      distanceToFinalPct: currentIndex ? (position.entryIndex * 1.5 / currentIndex - 1) * 100 : null,
      maximumExitAt: position.entryAt + (position.tp1Complete ? this.config.bot.exit.maxTotalHoldMinutes : this.config.bot.exit.maxHoldBeforeTp1Minutes) * 60_000
    };
  }

  _sessionStatistics() {
    const completed = this.state.bot.closedPositions.filter((position) => position.sessionId === this.sessionId && position.mode === 'BOT_PAPER');
    const executable = completed.filter((position) => position.fillQuality === 'EXECUTABLE_PRICE');
    const proxy = completed.filter((position) => position.fillQuality === 'PROXY_ONLY');
    const summarize = (items) => ({
      trades: items.length, completedTrades: items.length, wins: items.filter((item) => item.realizedPnlSol > 0).length,
      losses: items.filter((item) => item.realizedPnlSol <= 0).length,
      winRatePct: items.length ? items.filter((item) => item.realizedPnlSol > 0).length / items.length * 100 : 0,
      netPnlSol: items.reduce((sum, item) => sum + Number(item.realizedPnlSol || 0), 0),
      realizedNetPnlSol: items.reduce((sum, item) => sum + Number(item.realizedPnlSol || 0), 0)
    });
    return {
      all: summarize(completed), executable: summarize(executable), proxy: summarize(proxy),
      realisticNetPnlSol: summarize(executable).netPnlSol,
      averageHoldMs: mean(completed.map((item) => item.exitAt - item.entryAt)),
      bestTradePnlSol: completed.length ? Math.max(...completed.map((item) => item.realizedPnlSol)) : 0,
      worstTradePnlSol: completed.length ? Math.min(...completed.map((item) => item.realizedPnlSol)) : 0
    };
  }

  snapshot(mint = '') {
    const base = super.snapshot(mint);
    const candidates = Object.values(this.state.bot.candidates).sort((a, b) => b.updatedAt - a.updatedAt);
    const candidate = (mint && this.state.bot.candidates[mint]) || candidates[0] || null;
    const positions = Object.values(this.state.bot.positions).map((position) => this._positionSnapshot(position));
    const selectedPosition = (mint && positions.find((position) => position.mint === mint)) || positions[0] || null;
    const botRealizedPnlSol = [...Object.values(this.state.bot.positions), ...this.state.bot.closedPositions].reduce((sum, position) => sum + Number(position.realizedPnlSol || 0), 0);
    const botUnrealizedPnlSol = positions.reduce((sum, position) => sum + position.unrealizedPnlSol, 0);
    return {
      ...base,
      mode: this.state.bot.mode,
      strategy: this.state.bot.mode === 'BOT_PAPER' ? this.config.bot.paperAggressive.strategyVersion : 'wallet-consensus-trajectory-v1',
      aggressivePaper: this.state.bot.mode === 'BOT_PAPER', autoRun: this.state.bot.autoRun,
      liveArmedThisSession: this.state.bot.liveArmedThisSession, liveReadiness: this.state.bot.liveReadiness,
      needsReconciliation: this.state.bot.needsReconciliation, candidate, candidates: candidates.slice(0, 20),
      botPosition: selectedPosition, botPositions: positions, botRealizedPnlSol, botUnrealizedPnlSol,
      currentExitStage: selectedPosition?.stage || 'NO_POSITION', latestSignal: this.state.bot.latestSignal,
      latestDecision: this.state.bot.latestDecision, latestFill: this.state.bot.latestFill,
      latestFailure: this.state.bot.latestFailure, latestTransactionId: this.state.bot.latestTransactionId,
      candidateWalletCount: this.config.wallets.filter((wallet) => wallet.enabled).length,
      thresholds: this.config.bot, sessionFunnel: { ...this.state.bot.sessionStats, open: positions.length },
      sessionStatistics: this._sessionStatistics(), auditStatus: this.auditWriter?.status() || { enabled: false },
      followEnabled: undefined
    };
  }
}

module.exports = { AutoBotEngine, freshBotState };
