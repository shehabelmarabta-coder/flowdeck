'use strict';

const { atomic, atomicToDecimalString, atomicToDisplayNumber, applyHaircut, decimalToAtomic, SOL_MINT } = require('./atomic');
const { betaPosterior, clusteredOutcomes, evaluateBrain, evidenceGrade } = require('./brain');
const { AutoBotEngine } = require('./bot-engine');
const { configHash, immutableSnapshot, sha256, stableJson } = require('./decision-snapshot');

const COHORTS = [
  'UNIVERSE_CONTROL', 'WALLET_SIGNAL', 'DECODE_FAILED', 'MISSED_BACKFILLED', 'REJECTED',
  'QUOTE_EXPIRED', 'NO_ENTRY_ROUTE', 'NO_SELL_ROUTE', 'PAPER_ENTERED', 'OPEN_CENSORED',
  'PAPER_CLOSED', 'UNSELLABLE', 'STOPPED_WATCH', 'POST_EXIT_WATCH'
];

function iso(timestamp) { return timestamp == null ? '' : new Date(timestamp).toISOString(); }
function finite(value, fallback = null) { if (value == null || value === '') return fallback; const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function costLamports(config) { return decimalToAtomic(String(config.paper.networkFeeSol), 9) + decimalToAtomic(String(config.paper.priorityFeeSol), 9); }
function pctFromRatio(numerator, denominator) { return denominator > 0n ? Number((numerator - denominator) * 1_000_000n / denominator) / 10_000 : null; }

function freshV3(previous = {}, config) {
  return {
    version: 3,
    cohorts: Object.fromEntries(COHORTS.map((cohort) => [cohort, Number(previous.cohorts?.[cohort] || 0)])),
    cohortKeys: Array.isArray(previous.cohortKeys) ? previous.cohortKeys.slice(-10000) : [],
    decisionSnapshots: previous.decisionSnapshots && typeof previous.decisionSnapshots === 'object' ? previous.decisionSnapshots : {},
    outcomeWatches: previous.outcomeWatches && typeof previous.outcomeWatches === 'object' ? previous.outcomeWatches : {},
    universe: previous.universe && typeof previous.universe === 'object' ? previous.universe : {},
    walletPairMints: previous.walletPairMints && typeof previous.walletPairMints === 'object' ? previous.walletPairMints : {},
    reentriesByMint: previous.reentriesByMint && typeof previous.reentriesByMint === 'object' ? previous.reentriesByMint : {},
    lastSourceWalletsByMint: previous.lastSourceWalletsByMint && typeof previous.lastSourceWalletsByMint === 'object' ? previous.lastSourceWalletsByMint : {},
    lastPositionIdByMint: previous.lastPositionIdByMint && typeof previous.lastPositionIdByMint === 'object' ? previous.lastPositionIdByMint : {},
    counterfactualSummary: previous.counterfactualSummary && typeof previous.counterfactualSummary === 'object' ? previous.counterfactualSummary : {},
    stoppedRecoveryIds: Array.isArray(previous.stoppedRecoveryIds) ? previous.stoppedRecoveryIds.slice(-10000) : [],
    restartCount: Number(previous.restartCount || 0) + 1,
    dataGaps: Number(previous.dataGaps || 0),
    walletBuySignals: Number(previous.walletBuySignals || 0),
    walletSellSignals: Number(previous.walletSellSignals || 0),
    quoteAttempts: Number(previous.quoteAttempts || 0),
    referenceMarks: Number(previous.referenceMarks || 0),
    schemaVersion: 'flowdeck-paper-v3',
    horizonsMs: config.jupiter.counterfactualHorizonsMs
  };
}

class SurvivorshipPaperEngine extends AutoBotEngine {
  constructor(options) {
    super(options);
    this.codeVersion = options.codeVersion || '0.3.0';
    this.configHash = configHash(this.config);
    this.state.v3 = freshV3(this.state.v3, this.config);
    this.snapshots = new Map(Object.entries(this.state.v3.decisionSnapshots).map(([id, value]) => [id, immutableSnapshot({ ...value, snapshot_id: id })]));
    this.quoteLocks = new Set();
    for (const position of Object.values(this.state.bot.positions)) {
      if (!position.quoteDriven) {
        position.legacyReferenceOnly = true;
        position.fillQuality = 'REFERENCE_MARK';
        position.routeStatus = 'LEGACY_REFERENCE_ONLY';
      }
    }
    this._writeManifest('SESSION_START');
    this._commit();
  }

  setMode(mode) {
    if (mode === 'BOT_LIVE') return { status: 'blocked', reason: 'BOT_LIVE is blocked in FlowDeck v0.3 paper-only mode.' };
    return super.setMode('BOT_PAPER');
  }

  setExecutionAdapters(adapters) {
    super.setExecutionAdapters(adapters);
    if (this.state?.v3) this._writeManifest('JUPITER_READY');
  }

  _cohortKey(cohort, data) { return `${cohort}:${data.mint || ''}:${data.signature || data.signalSignature || ''}:${data.decisionId || ''}:${data.positionId || ''}:${data.reason || ''}`; }

  recordOutcome(cohort, data = {}) {
    if (!COHORTS.includes(cohort)) throw new Error(`Unknown outcome cohort: ${cohort}`);
    const key = data.key || this._cohortKey(cohort, data);
    if (this.state.v3.cohortKeys.includes(key)) return { written: false, duplicate: true };
    this.state.v3.cohortKeys.push(key); this.state.v3.cohortKeys = this.state.v3.cohortKeys.slice(-10000);
    this.state.v3.cohorts[cohort] += 1;
    const outcomeId = data.outcomeId || `outcome_${sha256(`${this.sessionId}:${key}`).slice(0, 24)}`;
    const market = this.markets.get(data.mint) || {};
    const baselineField = data.baselineField || (data.baselineValue != null
      ? 'supplied'
      : Number(market.priceUsd) > 0 ? 'priceUsd' : Number(market.marketCapUsd) > 0 ? 'marketCapUsd' : 'unavailable');
    const baselineValue = data.baselineValue ?? (baselineField === 'priceUsd' ? market.priceUsd : market.marketCapUsd) ?? null;
    const baselineAt = data.baselineAt || market.receivedAt || this.clock();
    const row = {
      session_id: this.sessionId, outcome_id: outcomeId, decision_id: data.decisionId || '',
      position_id: data.positionId || '', snapshot_id: data.snapshotId || '', timestamp_utc: iso(this.clock()),
      cohort, mint: data.mint || '', symbol: data.symbol || market.symbol || '', source_wallet: data.wallet || '',
      signal_signature: data.signature || data.signalSignature || '', reason: data.reason || '',
      baseline_timestamp_utc: iso(baselineAt),
      baseline_quality: data.baselineQuality || (baselineValue == null ? 'UNAVAILABLE' : 'REFERENCE_MARK'),
      baseline_value: baselineValue ?? '', horizon_ms: data.horizonMs ?? 0,
      observation_timestamp_utc: iso(data.observationAt || this.clock()), observation_quality: data.observationQuality || '',
      observation_value: data.observationValue ?? '', return_pct: data.returnPct ?? '',
      available: data.available ?? (baselineValue != null), censored: data.censored ?? false,
      actual_pnl_eligible: false, notes: data.notes || ''
    };
    this.auditWriter?.writeOutcome?.(row);
    if (data.watch !== false && ['WALLET_SIGNAL', 'REJECTED', 'QUOTE_EXPIRED', 'NO_ENTRY_ROUTE', 'NO_SELL_ROUTE', 'PAPER_ENTERED', 'PAPER_CLOSED', 'STOPPED_WATCH', 'POST_EXIT_WATCH', 'UNIVERSE_CONTROL'].includes(cohort)) {
      this.state.v3.outcomeWatches[outcomeId] = {
        outcomeId, cohort, mint: row.mint, symbol: row.symbol, decisionId: row.decision_id,
        positionId: row.position_id, snapshotId: row.snapshot_id, baselineAt,
        baselineQuality: row.baseline_quality, baselineField, baselineValue, completedHorizons: []
      };
    }
    this._commit(); return { written: true, outcomeId };
  }

  recordObservation(evidence = {}) {
    // Raw notifications are counted in observation health. Material classifications and failures
    // carry the notification timestamp into the append-only audit without duplicating every log line.
    if (evidence.type === 'RPC_NOTIFICATION') return;
    if (evidence.type === 'RPC_DATA_GAP') this.state.v3.dataGaps += 1;
    if (evidence.type === 'DECODE_FAILED') this.recordOutcome('DECODE_FAILED', { mint: evidence.mint || '', wallet: evidence.wallet, signature: evidence.signature, reason: evidence.error, watch: false });
    if (evidence.type === 'MISSED_BACKFILLED') this.recordOutcome('MISSED_BACKFILLED', { wallet: evidence.wallet, signature: evidence.signature, reason: 'Reconnect catch-up', watch: false });
    const { logs, ...auditEvidence } = evidence;
    const notes = Array.isArray(logs)
      ? { ...auditEvidence, logCount: logs.length, logsHash: sha256(logs) }
      : auditEvidence;
    this._auditEvent(evidence.type || 'RPC_EVIDENCE', {
      eventId: `rpc:${evidence.type}:${evidence.signature || this.clock()}:${evidence.wallet || ''}`,
      sourceWallet: evidence.wallet,
      sourceSignature: evidence.signature,
      notes,
      queued: true
    });
  }

  observeDiscovery(input) {
    const result = super.observeDiscovery(input);
    const mint = String(input?.mint || '');
    if (mint && !this.state.v3.universe[mint]) {
      this.state.v3.universe[mint] = { firstSeenAt: this.clock(), symbol: input.symbol || '', lifecycleStage: input.status || '' };
      this.recordOutcome('UNIVERSE_CONTROL', { mint, symbol: input.symbol, reason: 'Eligible GMGN DOM/trenches universe observation' });
    }
    return result;
  }

  async handleWalletSignal(input) {
    const side = String(input?.side || '').toLowerCase();
    if (side === 'buy') this.state.v3.walletBuySignals += 1;
    if (side === 'sell') this.state.v3.walletSellSignals += 1;
    if (['buy', 'sell'].includes(side)) this.recordOutcome('WALLET_SIGNAL', {
      mint: input.mint, symbol: input.symbol, wallet: input.wallet, signature: input.signature,
      reason: `${input.backfilled ? 'Backfilled' : 'Observed'} wallet ${side}`, baselineAt: input.classificationAt || this.clock()
    });
    const result = await super.handleWalletSignal(input);
    const candidate = this.state.bot.candidates[String(input?.mint || '')];
    if (candidate) {
      candidate.lastSignalSlot = input.slot ?? candidate.lastSignalSlot ?? null;
      candidate.lastSignalCommitment = input.commitment || candidate.lastSignalCommitment || 'processed';
      candidate.detectionLatencyMs = input.detectionLatencyMs ?? candidate.detectionLatencyMs ?? null;
      const sources = [...candidate.sourceWallets].sort((left, right) => left.address.localeCompare(right.address));
      for (let left = 0; left < sources.length; left += 1) for (let right = left + 1; right < sources.length; right += 1) {
        if (Math.abs(Number(sources[left].observedAt || 0) - Number(sources[right].observedAt || 0)) > 30_000) continue;
        const pair = `${sources[left].address}|${sources[right].address}`;
        const mints = new Set(this.state.v3.walletPairMints[pair] || []);
        mints.add(candidate.mint);
        this.state.v3.walletPairMints[pair] = [...mints].slice(-1000);
      }
      this._commit();
    }
    return result;
  }

  _queueQuote(candidate, reason = 'WAITING FOR JUPITER QUOTE') {
    const now = this.clock();
    candidate.priceWaitStartedAt ||= now;
    candidate.state = 'WAITING_PRICE';
    candidate.nextPriceAttemptAt = now + this.config.bot.paperAggressive.priceRetryMs;
    candidate.reason = `${reason} — ${Math.floor((now - candidate.priceWaitStartedAt) / 1000)}s / ${this.config.bot.paperAggressive.priceWaitTimeoutSeconds}s`;
    candidate.priceAttempts.push({ at: now, sources: ['JUPITER_ORDER_ENTRY', 'JUPITER_ORDER_IMMEDIATE_REVERSE'] });
    candidate.priceAttempts = candidate.priceAttempts.slice(-25);
    this.state.v3.quoteAttempts += 1;
    this._auditEvent('PRICE_ATTEMPT', { candidate, eventId: `jupiter-attempt:${this.sessionId}:${candidate.mint}:${now}`, notes: 'JUPITER_ORDER_ENTRY > JUPITER_ORDER_IMMEDIATE_REVERSE' });
    this._commit(); return { status: 'awaiting-quote', reason: candidate.reason };
  }

  _writeQuote(quote, context = {}) {
    if (!quote) return null;
    quote.quoteId ||= `quote_${this._id('jupiter')}`;
    const inputDecimals = context.inputDecimals ?? (quote.inputMint === SOL_MINT ? 9 : context.tokenDecimals ?? '');
    const outputDecimals = context.outputDecimals ?? (quote.outputMint === SOL_MINT ? 9 : context.tokenDecimals ?? '');
    this.auditWriter?.writeQuote?.({
      session_id: this.sessionId, quote_id: quote.quoteId, decision_id: context.decisionId || '',
      position_id: context.positionId || '', snapshot_id: context.snapshotId || '', timestamp_utc: iso(quote.receivedAt || this.clock()),
      purpose: quote.purpose || context.purpose || '', input_mint: quote.inputMint || '', output_mint: quote.outputMint || '',
      input_amount_atomic: quote.inputAmountAtomic || '', output_amount_atomic: quote.outAmountAtomic || '',
      minimum_output_atomic: quote.minimumOutputAtomic || '', input_decimals: inputDecimals, output_decimals: outputDecimals,
      input_display: inputDecimals === '' ? '' : atomicToDecimalString(quote.inputAmountAtomic || '0', inputDecimals),
      output_display: outputDecimals === '' || !quote.outAmountAtomic ? '' : atomicToDecimalString(quote.outAmountAtomic, outputDecimals),
      request_id: quote.requestId || '', router: quote.router || '', mode: quote.mode || '', price_quality: quote.priceQuality || '',
      transaction_present: Boolean(quote.transactionPresent), request_timestamp_utc: quote.requestTimestampUtc || '',
      response_timestamp_utc: quote.responseTimestampUtc || '', latency_ms: quote.latencyMs ?? '', quote_age_ms: Math.max(0, this.clock() - Number(quote.receivedAt || this.clock())),
      fee_bps: quote.feeBps ?? '', fee_mint: quote.feeMint || '', platform_fee_amount_atomic: quote.platformFeeAmountAtomic || '',
      platform_fee_bps: quote.platformFeeBps ?? '', haircut_bps: this.config.jupiter.paperExecutionHaircutBps,
      http_status: quote.httpStatus ?? '', error_code: quote.errorCode ?? '', error_message: quote.errorMessage || '', cached: Boolean(quote.cached), notes: context.notes || ''
    });
    return quote.quoteId;
  }

  _referenceMark(mint, asOf = Infinity) {
    const market = this.markets.get(mint);
    if (!market) return { available: false, quality: 'UNAVAILABLE' };
    const observedAt = Number(market.observedAt || market.receivedAt || 0);
    if (observedAt > asOf) return { available: false, quality: 'UNAVAILABLE', reason: 'AFTER_DECISION_EXCLUDED' };
    return { available: true, quality: 'REFERENCE_MARK', source: market.source, observedAt: market.observedAt, receivedAt: market.receivedAt, priceUsd: market.priceUsd, marketCapUsd: market.marketCapUsd };
  }

  _snapshot(candidate, decision, assessment, brain) {
    const market = this._referenceMark(candidate.mint, decision.decidedAt);
    const snapshotId = `snapshot_${sha256(`${this.sessionId}:${decision.id}`).slice(0, 24)}`;
    const feature = (value, observedAt, source = '') => {
      const timestamp = Number(observedAt || 0);
      const available = value != null && timestamp > 0 && timestamp <= decision.decidedAt;
      return { value: available ? value : null, available, observed_at: available ? iso(timestamp) : null, age_ms: available ? decision.decidedAt - timestamp : null, source: source || null, unavailable_reason: available ? null : timestamp > decision.decidedAt ? 'AFTER_DECISION_EXCLUDED' : 'UNAVAILABLE' };
    };
    const independentBuys = (windowMs) => candidate.sourceWallets.filter((wallet) => decision.decidedAt - Number(wallet.observedAt || 0) <= windowMs).length;
    const marketObservedAt = market.available ? Number(market.observedAt || market.receivedAt) : null;
    const snapshot = immutableSnapshot({
      schema_version: 'flowdeck-decision-v3', snapshot_id: snapshotId, session_id: this.sessionId, decision_id: decision.id,
      strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', config_hash: this.configHash, code_version: this.codeVersion,
      mint: candidate.mint, symbol: candidate.symbol, lifecycle_stage: candidate.lifecycleStage,
      first_seen_timestamp_utc: iso(candidate.firstSignalAt), signal_timestamp_utc: iso(decision.signalObservedAt),
      decision_timestamp_utc: iso(decision.decidedAt), quote_timestamp_utc: assessment.entry?.responseTimestampUtc || '',
      signal: {
        signature: candidate.sourceSignatures[0] || '', slot: candidate.lastSignalSlot || null,
        commitment: candidate.lastSignalCommitment || 'processed', source_wallet: candidate.sourceWallets[0]?.address || '',
        detection_latency_ms: candidate.detectionLatencyMs ?? null
      },
      wallet_cluster: brain.walletClusters[0]?.id || null, wallet_count: candidate.walletCount,
      independent_cluster_count: brain.independentClusterCount, consensus_pct: candidate.weightedConsensusPct,
      posterior: { tp1: brain.tp1Posterior, final: brain.finalPosterior }, brain,
      features: {
        signal_age_ms: feature(brain.signalAgeMs, decision.decidedAt, 'wallet-listener'),
        detection_latency_ms: feature(candidate.detectionLatencyMs, candidate.lastSignalAt, 'wallet-listener'),
        lifecycle: feature(candidate.lifecycleStage, candidate.updatedAt, 'gmgn-observation'),
        time_since_migration_ms: feature(null, null),
        source_wallet: feature(candidate.sourceWallets[0]?.address || null, candidate.sourceWallets[0]?.observedAt, 'wallet-listener'),
        independent_cluster_count: feature(brain.independentClusterCount, decision.decidedAt, 'correlation-cap'),
        independent_buys_5s: feature(independentBuys(5_000), decision.decidedAt, 'wallet-listener'),
        independent_buys_15s: feature(independentBuys(15_000), decision.decidedAt, 'wallet-listener'),
        independent_buys_30s: feature(independentBuys(30_000), decision.decidedAt, 'wallet-listener'),
        wallet_unique_mint_sample: feature(brain.walletUniqueMintSample, decision.decidedAt, 'unique-mint-history'),
        jupiter_entry_route: feature(Boolean(assessment.entry?.ok), assessment.entry?.receivedAt, 'jupiter-order-v2'),
        jupiter_reverse_route: feature(Boolean(assessment.reverse?.ok), assessment.reverse?.receivedAt, 'jupiter-order-v2'),
        round_trip_loss_bps: feature(assessment.roundTripLossBps, assessment.reverse?.receivedAt, 'jupiter-order-v2'),
        quote_latency_ms: feature(Number(assessment.entry?.latencyMs || 0) + Number(assessment.reverse?.latencyMs || 0), assessment.reverse?.receivedAt, 'jupiter-order-v2'),
        quote_age_ms: feature(Math.max(0, decision.decidedAt - Number(assessment.reverse?.receivedAt || decision.decidedAt)), decision.decidedAt, 'jupiter-order-v2'),
        executable_return_5s: feature(null, null), executable_return_15s: feature(null, null), executable_return_30s: feature(null, null),
        momentum_acceleration: feature(null, null), unique_buyer_seller_imbalance: feature(null, null), volume_acceleration: feature(null, null),
        liquidity_usd: feature(candidate.liquidityUsd, marketObservedAt, 'reference-mark'),
        market_cap_usd: feature(candidate.marketCapUsd, marketObservedAt, 'reference-mark'),
        liquidity_change: feature(null, null), market_cap_change: feature(null, null),
        creator_selling: feature(candidate.riskFlags?.creatorSelling ?? null, marketObservedAt, 'risk-flags'),
        rapid_liquidity_loss: feature(candidate.riskFlags?.rapidLiquidityLoss ?? null, marketObservedAt, 'risk-flags'),
        holder_concentration: feature(candidate.riskFlags?.holderConcentration ?? null, marketObservedAt, 'risk-flags'),
        pre_entry_sharp_move: feature(null, null), trajectory: feature(candidate.trajectory?.label === 'unavailable' ? null : candidate.trajectory, candidate.updatedAt, 'trajectory-index'),
        narrative_context: feature(null, null)
      },
      thresholds: { ...this.config.bot.exit, signal_expiry_seconds: this.config.bot.paperAggressive.priceWaitTimeoutSeconds, material_negative_sol: this.config.bot.brain.materialNegativeSol },
      jupiter: {
        entry: assessment.entry, reverse: assessment.reverse, quoted_token_atomic: assessment.quotedTokenAtomic,
        conservative_token_atomic: assessment.conservativeTokenAtomic, token_decimals: assessment.tokenDecimals,
        round_trip_loss_lamports: assessment.roundTripLossLamports, round_trip_loss_bps: assessment.roundTripLossBps,
        paper_execution_haircut_bps: this.config.jupiter.paperExecutionHaircutBps
      },
      reference_mark: market, risk_flags: candidate.riskFlags || {}, security: candidate.security || {},
      decision_reasons: { positive: brain.positiveReasons, negative: brain.negativeReasons, hard_gate: brain.hardGate },
      action: brain.action, entry_atomic: { input_mint: SOL_MINT, input_amount: assessment.entry.inputAmountAtomic, input_decimals: 9, output_mint: candidate.mint, output_amount: assessment.conservativeTokenAtomic, output_decimals: assessment.tokenDecimals }
    });
    this.snapshots.set(snapshot.snapshot_id, snapshot);
    this.state.v3.decisionSnapshots[snapshot.snapshot_id] = JSON.parse(stableJson(snapshot));
    const snapshotHash = sha256(snapshot);
    this.auditWriter?.writeSnapshot?.({
      session_id: this.sessionId, snapshot_id: snapshot.snapshot_id, decision_id: decision.id,
      position_id: `position_${decision.id}`, timestamp_utc: iso(decision.decidedAt), strategy_version: snapshot.strategy_version,
      config_hash: snapshot.config_hash, code_version: snapshot.code_version, mint: snapshot.mint, symbol: snapshot.symbol,
      lifecycle_stage: snapshot.lifecycle_stage, signal_signature: snapshot.signal.signature, signal_slot: snapshot.signal.slot ?? '',
      signal_commitment: snapshot.signal.commitment, source_wallet: snapshot.signal.source_wallet,
      wallet_cluster: snapshot.wallet_cluster || '', wallet_count: snapshot.wallet_count,
      independent_cluster_count: snapshot.independent_cluster_count, action: brain.action, evidence_grade: brain.evidenceGrade,
      hard_gate: brain.hardGate, tp1_posterior_mean: brain.tp1Posterior.mean,
      tp1_credible_low: brain.tp1Posterior.credibleInterval[0], tp1_credible_high: brain.tp1Posterior.credibleInterval[1],
      final_posterior_mean: brain.finalPosterior.mean, final_credible_low: brain.finalPosterior.credibleInterval[0],
      final_credible_high: brain.finalPosterior.credibleInterval[1], expected_net_sol: brain.expectedNetSol,
      entry_input_atomic: assessment.entry.inputAmountAtomic, entry_output_atomic: assessment.conservativeTokenAtomic,
      reverse_output_atomic: assessment.reverse.outAmountAtomic, token_decimals: assessment.tokenDecimals ?? '',
      snapshot_hash: snapshotHash, snapshot_json: stableJson(snapshot)
    });
    return snapshot;
  }

  async _considerEntry(mint, signalObservedAt = null) {
    const adapter = this.executionAdapters.BOT_PAPER;
    if (!adapter?.client) return super._considerEntry(mint, signalObservedAt);
    if (!this.state.bot.autoRun || this.entryLocks.has(mint) || this.state.bot.positions[mint]) return { status: 'observed' };
    const candidate = this._candidate(mint);
    const entryCount = Number(this.state.v3.reentriesByMint[mint] || 0);
    const maximumReentries = this.config.bot.brain.maximumReentriesPerMint;
    const previousSources = this.state.v3.lastSourceWalletsByMint[mint] || [];
    const hasNewIndependentWallet = candidate.sourceWallets.some((wallet) => !previousSources.includes(wallet.address));
    const blocker = entryCount > maximumReentries
      ? `maximum ${maximumReentries} paper re-entry reached`
      : entryCount > 0 && !hasNewIndependentWallet
        ? 're-entry requires a new independent-wallet signal'
        : this._paperHardBlocker(mint);
    if (blocker) {
      candidate.state = 'REJECTED'; candidate.finalDecision = 'REJECT'; candidate.reason = blocker;
      this.recordOutcome('REJECTED', { mint, symbol: candidate.symbol, decisionId: candidate.decisionId, reason: blocker });
      this._auditEvent('REJECTED', { candidate, rejectionReason: blocker, eventId: `v3-rejected:${candidate.decisionId}:${this.clock()}` });
      return { status: 'rejected', reason: blocker };
    }
    this.entryLocks.add(mint);
    try {
      const amountSol = this.config.bot.paperAggressive.orderSol;
      const quote = await adapter.quote({ mint, side: 'buy', amountSol });
      const assessment = quote.assessment;
      if (assessment?.entry) this._writeQuote(assessment.entry, { decisionId: candidate.decisionId, tokenDecimals: assessment.tokenDecimals, inputDecimals: 9, outputDecimals: assessment.tokenDecimals });
      if (assessment?.reverse) this._writeQuote(assessment.reverse, { decisionId: candidate.decisionId, tokenDecimals: assessment.tokenDecimals, inputDecimals: assessment.tokenDecimals, outputDecimals: 9 });
      const staleRoundTrip = quote.ok && [assessment?.entry, assessment?.reverse].some((item) => this.clock() - Number(item?.receivedAt || 0) > this.config.jupiter.quoteMaxAgeMs);
      if (staleRoundTrip) { quote.ok = false; assessment.outcome = 'QUOTE_EXPIRED'; }
      const elapsed = this.clock() - Number(candidate.priceWaitStartedAt || candidate.firstSignalAt || this.clock());
      if (!quote.ok) {
        if (elapsed < this.config.bot.paperAggressive.priceWaitTimeoutSeconds * 1000) return this._queueQuote(candidate, assessment?.outcome || 'WAITING FOR JUPITER QUOTE');
        const cohort = assessment?.outcome === 'NO_SELL_ROUTE' ? 'NO_SELL_ROUTE' : assessment?.outcome === 'NO_ENTRY_ROUTE' ? 'NO_ENTRY_ROUTE' : 'QUOTE_EXPIRED';
        candidate.state = 'EXPIRED'; candidate.finalDecision = 'EXPIRED'; candidate.reason = assessment?.outcome || 'QUOTE_EXPIRED';
        this.state.bot.sessionStats.priceExpiries += 1;
        this.recordOutcome(cohort, { mint, symbol: candidate.symbol, decisionId: candidate.decisionId, reason: candidate.reason });
        this._auditEvent('EXPIRED', { candidate, rejectionReason: candidate.reason, eventId: `v3-expired:${candidate.decisionId}` });
        return { status: 'expired', reason: candidate.reason };
      }
      const decisionAt = this.clock();
      const brain = evaluateBrain({ candidate, assessment, closedPositions: this.state.bot.closedPositions, config: this.config, decisionAt, pairCommonMints: this._pairCounts() });
      const decision = {
        id: candidate.decisionId || this._id('decision'), action: brain.action, mode: 'BOT_PAPER', mint,
        path: 'jupiter-bayes-paper', quote, brain, signalObservedAt: finite(signalObservedAt, candidate.firstSignalAt),
        decidedAt: decisionAt, status: 'pending-paper-fill'
      };
      const snapshot = this._snapshot(candidate, decision, assessment, brain);
      decision.snapshotId = snapshot.snapshot_id;
      candidate.snapshotId = snapshot.snapshot_id; candidate.brain = brain; candidate.finalDecision = brain.action;
      if (brain.action !== 'BUY') {
        candidate.state = brain.action === 'EXPIRED' ? 'EXPIRED' : 'REJECTED'; candidate.reason = brain.hardGate;
        this.recordOutcome(brain.action === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'REJECTED', { mint, symbol: candidate.symbol, decisionId: decision.id, snapshotId: snapshot.snapshot_id, reason: brain.hardGate });
        this._auditEvent('REJECTED', { candidate, decision, rejectionReason: brain.hardGate, eventId: `brain-reject:${decision.id}` });
        return { status: brain.action.toLowerCase(), reason: brain.hardGate, brain, snapshot };
      }
      candidate.reason = 'Fresh amount-specific Jupiter entry and immediate reverse route; paper-only fill.';
      this.state.bot.pendingDecision = decision; this._commit();
      const result = await adapter.buy({ mint, amountSol, symbol: candidate.symbol, decision });
      if (!result.confirmed) throw new Error(result.reason || 'Jupiter paper fill failed');
      const fill = result.fill;
      const position = {
        mint, symbol: candidate.symbol, mode: 'BOT_PAPER', quoteDriven: true,
        positionId: `position_${decision.id}`, tradeId: candidate.tradeId || `trade_${decision.id}`,
        decisionId: decision.id, snapshotId: snapshot.snapshot_id, sessionId: this.sessionId,
        originalPositionId: this.state.v3.lastPositionIdByMint[mint] || null,
        lifecycleStage: candidate.lifecycleStage, stage: 'BEFORE_TP1', entryAt: this.clock(),
        entrySignalAt: decision.signalObservedAt, decisionAt: decision.decidedAt, entryIndex: 1,
        pricingUnit: 'JUPITER_REVERSE_SOL', fillQuality: fill.priceQuality, priceQuality: fill.priceQuality,
        tokenDecimals: fill.outputDecimals, initialTokenAmountAtomic: fill.outputAmountAtomic,
        remainingTokenAmountAtomic: fill.outputAmountAtomic, entrySpendLamports: fill.entrySpendLamports,
        explicitModeledCostsLamports: fill.totalCostLamports, totalExitProceedsLamports: '0',
        realizedPnlLamports: '0', initialAmountSol: amountSol, remainingPct: 100,
        tp1Complete: false, targetObservations: {}, pendingAction: null, realizedPnlSol: 0,
        grossProceedsSol: 0, netProceedsSol: 0, modeledFeesSol: atomicToDisplayNumber(fill.totalCostLamports, 9),
        modeledSlippageSol: 0, mfePct: 0, maePct: 0, maximumConsensusPct: candidate.weightedConsensusPct,
        lastOpenSampleAt: this.clock(), lastOutcomeSampleAt: null,
        outcomeEndsAt: this.clock() + this.config.bot.paperAggressive.outcomeWindowMinutes * 60_000,
        outcomeComplete: false, sourceWallets: structuredClone(candidate.sourceWallets),
        sourceSignatures: [...candidate.sourceSignatures], entryReason: candidate.reason,
        entryQuoteId: assessment.entry.quoteId, currentReverseQuote: structuredClone(assessment.reverse),
        routeStatus: 'SELLABLE', routeLostAt: null, lastQuoteAt: assessment.reverse.receivedAt,
        nextQuoteAt: this.clock(), brain: structuredClone(brain), currentReturnPct: null,
        highReturnPct: 0, lowReturnPct: 0, entryFillId: fill.id
      };
      candidate.state = 'BOUGHT'; candidate.tradeId = position.tradeId; candidate.updatedAt = this.clock();
      this.state.v3.reentriesByMint[mint] = entryCount + 1;
      this.state.v3.lastSourceWalletsByMint[mint] = position.sourceWallets.map((wallet) => wallet.address);
      this.state.bot.positions[mint] = position; this.state.bot.pendingDecision = null;
      this.state.bot.sessionStats.paperBuys += 1;
      this._applyReverseValuation(position, assessment.reverse);
      this._writeFill(position, fill, 'ENTRY');
      this.recordOutcome('PAPER_ENTERED', { mint, symbol: position.symbol, decisionId: decision.id, positionId: position.positionId, snapshotId: position.snapshotId, reason: 'Jupiter entry and reverse routes available' });
      this._botEvent('latestFill', 'entry-fill', 'PAPER BUY FILLED — JUPITER ROUTE', { mint, priceQuality: fill.priceQuality, snapshotId: snapshot.snapshot_id });
      this._auditEvent('PAPER_BUY', { candidate, position, fill, decision, eventId: `v3-fill:${fill.id}` });
      this._commit(); return { status: 'filled', position, result, brain, snapshot };
    } catch (error) {
      this.state.bot.pendingDecision = null; candidate.state = 'REJECTED'; candidate.finalDecision = 'REJECT'; candidate.reason = error.message;
      this.recordOutcome('REJECTED', { mint, symbol: candidate.symbol, decisionId: candidate.decisionId, reason: error.message });
      this._botEvent('latestFailure', 'entry-failure', error.message, { mint }); this._commit();
      return { status: 'failed', reason: error.message };
    } finally { this.entryLocks.delete(mint); }
  }

  _pairCounts() {
    return Object.fromEntries(Object.entries(this.state.v3.walletPairMints).map(([key, mints]) => [key, Array.isArray(mints) ? new Set(mints).size : Number(mints || 0)]));
  }

  _marketIndex(position, market) {
    if (position?.quoteDriven) return position.currentReturnPct == null ? null : 1 + position.currentReturnPct / 100;
    return super._marketIndex(position, market);
  }

  _applyReverseValuation(position, quote) {
    if (!quote?.ok) return false;
    if (this.clock() - Number(quote.receivedAt || 0) > this.config.jupiter.quoteMaxAgeMs) return false;
    const gross = applyHaircut(quote.outAmountAtomic, this.config.jupiter.paperExecutionHaircutBps);
    const exitCost = costLamports(this.config);
    const net = gross > exitCost ? gross - exitCost : 0n;
    const lot = this.state.lots.find((item) => item.mint === position.mint && item.source === 'jupiter-paper');
    const remainingBasis = lot ? atomic(lot.remainingEntrySpendLamports) + atomic(lot.remainingEntryCostLamports) : 0n;
    const returnPct = pctFromRatio(net, remainingBasis);
    position.currentReverseQuote = structuredClone(quote); position.lastQuoteAt = quote.receivedAt;
    position.currentNetValueLamports = net.toString(); position.currentGrossValueLamports = gross.toString();
    position.currentReturnPct = returnPct; position.highReturnPct = Math.max(position.highReturnPct || 0, returnPct ?? 0);
    position.lowReturnPct = Math.min(position.lowReturnPct || 0, returnPct ?? 0);
    position.mfePct = Math.max(position.mfePct || 0, returnPct ?? 0); position.maePct = Math.min(position.maePct || 0, returnPct ?? 0);
    position.routeStatus = 'SELLABLE'; position.routeLostAt = null;
    const distances = [Math.abs((returnPct ?? 0) + this.config.bot.exit.hardStopPct), Math.abs((returnPct ?? 0) - this.config.bot.exit.tp1Pct), Math.abs((returnPct ?? 0) - this.config.bot.exit.finalTakeProfitPct)];
    position.nextQuoteAt = this.clock() + (Math.min(...distances) <= 5 ? this.config.jupiter.nearQuoteIntervalMs : this.config.jupiter.farQuoteIntervalMs);
    return true;
  }

  async _refreshPositionQuote(position, purpose = 'POSITION_VALUE') {
    if (!position?.quoteDriven || this.quoteLocks.has(position.mint)) return null;
    this.quoteLocks.add(position.mint);
    try {
      const adapter = this.executionAdapters.BOT_PAPER;
      const quote = await adapter.quote({ mint: position.mint, side: 'sell', percent: 100, purpose });
      this._writeQuote(quote, { decisionId: position.decisionId, positionId: position.positionId, snapshotId: position.snapshotId, inputDecimals: position.tokenDecimals, outputDecimals: 9 });
      if (!quote.ok) {
        position.routeLostAt ||= this.clock(); position.routeStatus = 'UNSELLABLE/NO_ROUTE';
        position.currentReverseQuote = null; position.currentReturnPct = null; position.currentNetValueLamports = null;
        position.nextQuoteAt = this.clock() + this.config.jupiter.nearQuoteIntervalMs;
        if (this.clock() - position.routeLostAt >= this.config.jupiter.routeLossGraceMs && !position.unsellableRecorded) {
          position.unsellableRecorded = true; position.conservativeValueLamports = '0';
          this.recordOutcome('UNSELLABLE', { mint: position.mint, symbol: position.symbol, decisionId: position.decisionId, positionId: position.positionId, snapshotId: position.snapshotId, reason: quote.errorCode || 'NO_ROUTE' });
        }
        this._commit(); return quote;
      }
      if (!this._applyReverseValuation(position, quote)) {
        position.routeStatus = 'STALE_QUOTE'; position.currentReverseQuote = null;
        position.currentReturnPct = null; position.currentNetValueLamports = null;
      }
      this._commit(); return quote;
    } finally { this.quoteLocks.delete(position.mint); }
  }

  _observeMarketForPositions(mint, market) {
    const position = this.state.bot.positions[mint];
    if (position?.quoteDriven) {
      this.state.v3.referenceMarks += 1;
      if (this.state.bot.autoRun) void this._refreshPositionQuote(position, 'REFERENCE_MARK_TRIGGER').then(() => this._evaluateExit(mint));
      return;
    }
    super._observeMarketForPositions(mint, market);
  }

  _quoteExitAction(position) {
    const value = position.currentReturnPct;
    if (value == null) return null;
    const ageMs = this.clock() - position.entryAt;
    if (!position.tp1Complete) {
      if (value <= -this.config.bot.exit.hardStopPct) return { reason: 'hard-stop', percent: 100, final: true };
      if (ageMs >= this.config.bot.exit.maxHoldBeforeTp1Minutes * 60_000) return { reason: 'max-hold-before-tp1', percent: 100, final: true };
      if (value >= this.config.bot.exit.tp1Pct) return { reason: 'tp1', percent: 50, final: false };
      return null;
    }
    if (value >= this.config.bot.exit.finalTakeProfitPct) return { reason: 'final-take-profit', percent: 100, final: true };
    const highRatio = 1 + Number(position.highReturnPct || 0) / 100;
    const trailingRatio = Math.max(1, highRatio * (1 - this.config.bot.exit.trailingStopPct / 100));
    if (1 + value / 100 <= trailingRatio) return { reason: 'trailing-stop', percent: 100, final: true };
    if (ageMs >= this.config.bot.exit.maxTotalHoldMinutes * 60_000) return { reason: 'max-total-hold', percent: 100, final: true };
    return null;
  }

  async _evaluateExit(mint) {
    const position = this.state.bot.positions[mint];
    if (!position?.quoteDriven) return super._evaluateExit(mint);
    if (!this.state.bot.autoRun || position.pendingAction || this.exitLocks.has(mint)) return;
    if (!position.lastQuoteAt || this.clock() - position.lastQuoteAt > this.config.jupiter.quoteMaxAgeMs) await this._refreshPositionQuote(position, 'EXIT_CHECK');
    const action = this._quoteExitAction(position);
    if (!action || position.routeStatus !== 'SELLABLE') return;
    this.exitLocks.add(mint);
    const decision = { id: this._id('decision'), action: 'sell', mint, ...action, decidedAt: this.clock(), status: 'pending-paper-fill', snapshotId: position.snapshotId };
    position.pendingAction = decision; this.state.bot.pendingDecision = decision; this._commit();
    try {
      const adapter = this.executionAdapters.BOT_PAPER;
      const quote = await adapter.quote({ mint, side: 'sell', percent: action.percent, purpose: action.reason.toUpperCase() });
      decision.quote = quote;
      this._writeQuote(quote, { decisionId: decision.id, positionId: position.positionId, snapshotId: position.snapshotId, inputDecimals: position.tokenDecimals, outputDecimals: 9 });
      if (!quote.ok) { position.pendingAction = null; this.state.bot.pendingDecision = null; position.routeStatus = 'UNSELLABLE/NO_ROUTE'; this._commit(); return { status: 'no-route' }; }
      const result = await adapter.sellPercent({ mint, percent: action.percent, reason: action.reason, decision });
      if (!result.confirmed) throw new Error(result.reason || 'Paper exit fill failed');
      const fill = result.fill;
      position.pendingAction = null; this.state.bot.pendingDecision = null;
      position.realizedPnlLamports = (atomic(position.realizedPnlLamports) + atomic(fill.realizedPnlLamports)).toString();
      position.realizedPnlSol = atomicToDisplayNumber(position.realizedPnlLamports, 9);
      position.totalExitProceedsLamports = (atomic(position.totalExitProceedsLamports) + atomic(fill.outputAmountAtomic)).toString();
      position.explicitModeledCostsLamports = (atomic(position.explicitModeledCostsLamports) + atomic(fill.totalCostLamports)).toString();
      position.grossProceedsSol = atomicToDisplayNumber(position.totalExitProceedsLamports, 9);
      position.modeledFeesSol = atomicToDisplayNumber(position.explicitModeledCostsLamports, 9);
      position.netProceedsSol += Number(fill.netProceedsSol || 0);
      position.remainingTokenAmountAtomic = fill.resultingTokenBalanceAtomic;
      this._writeFill(position, fill, action.reason === 'tp1' ? 'TP1' : 'FINAL');
      const eventType = action.reason === 'tp1' ? 'TP1_SELL' : ['hard-stop', 'trailing-stop'].includes(action.reason) ? 'STOP_SELL' : action.reason.startsWith('max-') ? 'TIME_EXIT' : 'FINAL_SELL';
      if (action.final) {
        position.stage = 'CLOSED'; position.exitAt = this.clock(); position.exitReason = action.reason; position.remainingPct = 0;
        position.finalFillId = fill.id; position.lastOutcomeSampleAt = position.exitAt;
        this.state.bot.closedPositions.push(position); this.state.bot.closedPositions = this.state.bot.closedPositions.slice(-500);
        delete this.state.bot.positions[mint]; this.state.bot.lastClosedAtByMint[mint] = this.clock(); this.state.bot.sessionStats.closed += 1;
        this.state.v3.lastPositionIdByMint[mint] = position.positionId;
        this._writeV3Trade(position);
        this.recordOutcome('PAPER_CLOSED', { mint, symbol: position.symbol, decisionId: position.decisionId, positionId: position.positionId, snapshotId: position.snapshotId, reason: action.reason, watch: false });
        this.recordOutcome(action.reason === 'hard-stop' ? 'STOPPED_WATCH' : 'POST_EXIT_WATCH', { mint, symbol: position.symbol, decisionId: position.decisionId, positionId: position.positionId, snapshotId: position.snapshotId, reason: action.reason });
      } else {
        position.tp1Complete = true; position.stage = 'AFTER_TP1'; position.remainingPct = 50;
        position.tp1At = this.clock(); position.tp1FillId = fill.id; position.tp1Index = position.currentReturnPct;
      }
      this._botEvent('latestFill', 'exit-fill', action.reason === 'tp1' ? 'TP1 — 50% SOLD' : 'PAPER POSITION CLOSED', { mint, fillId: fill.id, priceQuality: fill.priceQuality });
      this._auditEvent(eventType, { position, fill, decision, eventId: `v3-fill:${fill.id}` }); this._commit();
      return result;
    } catch (error) {
      position.pendingAction = null; this.state.bot.pendingDecision = null;
      this._botEvent('latestFailure', 'paper-exit-failure', error.message, { mint }); this._commit(); return { status: 'failed', reason: error.message };
    } finally { this.exitLocks.delete(mint); }
  }

  _writeFill(position, fill, exitStage) {
    this.auditWriter?.writeFill?.({
      strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', session_id: this.sessionId, fill_id: fill.id,
      position_id: position.positionId, decision_id: fill.decisionId || position.decisionId, snapshot_id: position.snapshotId,
      timestamp_utc: iso(fill.at), side: fill.side, exit_stage: exitStage, input_mint: fill.inputMint,
      output_mint: fill.outputMint, input_amount_atomic: fill.inputAmountAtomic, output_amount_atomic: fill.outputAmountAtomic,
      input_decimals: fill.inputDecimals, output_decimals: fill.outputDecimals,
      input_display: atomicToDecimalString(fill.inputAmountAtomic, fill.inputDecimals), output_display: atomicToDecimalString(fill.outputAmountAtomic, fill.outputDecimals),
      quote_id: fill.quoteId || '', quote_request_id: fill.quoteRequestId || '', router: fill.router || '', price_quality: fill.priceQuality,
      entry_spend_lamports: fill.entrySpendLamports || '', allocated_entry_spend_lamports: fill.allocatedEntrySpendLamports || '',
      platform_fee_lamports: fill.platformFeeLamports || '0', network_fee_lamports: fill.networkFeeLamports || '0',
      priority_fee_lamports: fill.priorityFeeLamports || '0', other_fee_lamports: fill.otherFeeLamports || '0',
      total_cost_lamports: fill.totalCostLamports || '0', execution_haircut_bps: fill.executionHaircutBps || 0,
      resulting_token_balance_atomic: fill.resultingTokenBalanceAtomic, realized_pnl_lamports: fill.realizedPnlLamports || '0', notes: ''
    });
  }

  _writeV3Trade(position) {
    const netPnlLamports = atomic(position.totalExitProceedsLamports) - atomic(position.entrySpendLamports) - atomic(position.explicitModeledCostsLamports);
    this.auditWriter?.writeV3Trade?.({
      strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', session_id: this.sessionId, trade_id: position.tradeId,
      position_id: position.positionId, decision_id: position.decisionId, snapshot_id: position.snapshotId,
      mint: position.mint, symbol: position.symbol, lifecycle_stage: position.lifecycleStage,
      entry_timestamp_utc: iso(position.entryAt), final_exit_timestamp_utc: iso(position.exitAt), exit_reason: position.exitReason,
      entry_spend_lamports: position.entrySpendLamports, explicit_modelled_costs_lamports: position.explicitModeledCostsLamports,
      total_exit_proceeds_lamports: position.totalExitProceedsLamports, net_pnl_lamports: netPnlLamports.toString(),
      net_pnl_sol: atomicToDecimalString(netPnlLamports, 9),
      net_pnl_pct: Number(netPnlLamports * 1_000_000n / atomic(position.entrySpendLamports)) / 10_000,
      entry_token_amount_atomic: position.initialTokenAmountAtomic, final_token_balance_atomic: position.remainingTokenAmountAtomic,
      token_decimals: position.tokenDecimals, entry_quote_id: position.entryQuoteId, tp1_fill_id: position.tp1FillId || '',
      final_fill_id: position.finalFillId || '', price_quality: position.priceQuality, tp1_hit: Boolean(position.tp1Complete),
      mfe_pct: position.mfePct, mae_pct: position.maePct, wallet_count_at_entry: position.sourceWallets.length,
      independent_cluster_count_at_entry: position.brain.independentClusterCount,
      source_wallets: position.sourceWallets.map((item) => item.address).join('|'), source_signatures: position.sourceSignatures.join('|'),
      entry_consensus_pct: position.maximumConsensusPct, brain_evidence_grade: position.brain.evidenceGrade,
      brain_expected_net_sol: position.brain.expectedNetSol,
      observed_plus_15_before_exit: Boolean(position.targetObservations.PLUS_15?.beforeExit),
      observed_plus_50_before_exit: Boolean(position.targetObservations.PLUS_50?.beforeExit),
      observed_2x_before_exit: Boolean(position.targetObservations['2X']?.beforeExit),
      observed_4x_before_exit: Boolean(position.targetObservations['4X']?.beforeExit), notes: ''
    });
  }

  _sampleWatches() {
    const now = this.clock();
    for (const watch of Object.values(this.state.v3.outcomeWatches)) {
      for (const horizon of this.config.jupiter.counterfactualHorizonsMs) {
        if (watch.completedHorizons.includes(horizon) || now < watch.baselineAt + horizon) continue;
        const market = this.markets.get(watch.mint);
        const observationValue = watch.baselineQuality === 'REFERENCE_MARK'
          ? (watch.baselineField === 'priceUsd' ? market?.priceUsd : watch.baselineField === 'marketCapUsd' ? market?.marketCapUsd : null)
          : null;
        const available = Number(watch.baselineValue) > 0 && Number(observationValue) > 0;
        const returnPct = available ? (Number(observationValue) / Number(watch.baselineValue) - 1) * 100 : null;
        const summary = this.state.v3.counterfactualSummary[watch.cohort] || { observations: 0, available: 0, censored: 0, sumReturnPct: 0, maxReturnPct: null };
        summary.observations += 1;
        if (available) {
          summary.available += 1; summary.sumReturnPct += returnPct;
          summary.maxReturnPct = summary.maxReturnPct == null ? returnPct : Math.max(summary.maxReturnPct, returnPct);
          if (watch.cohort === 'STOPPED_WATCH' && returnPct >= 15 && !this.state.v3.stoppedRecoveryIds.includes(watch.outcomeId)) {
            this.state.v3.stoppedRecoveryIds.push(watch.outcomeId);
            this.state.v3.stoppedRecoveryIds = this.state.v3.stoppedRecoveryIds.slice(-10000);
          }
        } else summary.censored += 1;
        this.state.v3.counterfactualSummary[watch.cohort] = summary;
        const outcomeId = `${watch.outcomeId}:h${horizon}`;
        this.auditWriter?.writeOutcome?.({
          session_id: this.sessionId, outcome_id: outcomeId, decision_id: watch.decisionId || '',
          position_id: watch.positionId || '', snapshot_id: watch.snapshotId || '', timestamp_utc: iso(now),
          cohort: watch.cohort, mint: watch.mint, symbol: watch.symbol, source_wallet: '', signal_signature: '',
          reason: 'FIXED_HORIZON_COUNTERFACTUAL', baseline_timestamp_utc: iso(watch.baselineAt),
          baseline_quality: watch.baselineQuality, baseline_value: watch.baselineValue ?? '', horizon_ms: horizon,
          observation_timestamp_utc: iso(now), observation_quality: available ? 'REFERENCE_MARK' : 'UNAVAILABLE',
          observation_value: available ? observationValue : '', return_pct: returnPct ?? '', available,
          censored: !available, actual_pnl_eligible: false, notes: 'Counterfactual only; excluded from balance, equity and realised statistics.'
        });
        watch.completedHorizons.push(horizon);
      }
      if (watch.completedHorizons.length === this.config.jupiter.counterfactualHorizonsMs.length) delete this.state.v3.outcomeWatches[watch.outcomeId];
    }
  }

  async auditTick() {
    const adapter = this.executionAdapters.BOT_PAPER;
    if (!adapter?.client) return super.auditTick();
    const now = this.clock();
    for (const candidate of Object.values(this.state.bot.candidates)) {
      if (candidate.state !== 'WAITING_PRICE') continue;
      const elapsed = now - Number(candidate.priceWaitStartedAt || candidate.firstSignalAt || now);
      if (elapsed >= this.config.bot.paperAggressive.priceWaitTimeoutSeconds * 1000) await this._considerEntry(candidate.mint);
      else if (now >= Number(candidate.nextPriceAttemptAt || 0)) await this._considerEntry(candidate.mint);
    }
    for (const position of Object.values(this.state.bot.positions)) {
      if (position.quoteDriven && now >= Number(position.nextQuoteAt || 0)) await this._refreshPositionQuote(position);
      if (position.quoteDriven) await this._evaluateExit(position.mint);
      if (now - Number(position.lastOpenSampleAt || 0) >= this.config.bot.paperAggressive.openSampleMs) {
        position.lastOpenSampleAt = now;
        this._auditEvent('POSITION_SAMPLE', { position, eventId: `v3-sample:${position.positionId}:${Math.floor(now / this.config.bot.paperAggressive.openSampleMs)}`, notes: 'ACTUAL_OPEN_POSITION' });
      }
    }
    this._sampleWatches(); this._commit();
  }

  _robustStatistics() {
    const closed = this.state.bot.closedPositions.filter((position) => position.quoteDriven && position.sessionId === this.sessionId);
    const pnl = closed.map((position) => atomicToDisplayNumber(position.realizedPnlLamports || '0', 9));
    const gross = closed.reduce((sum, position) => sum + atomicToDisplayNumber(atomic(position.totalExitProceedsLamports || '0') - atomic(position.entrySpendLamports || '0'), 9), 0);
    const costs = closed.reduce((sum, position) => sum + atomicToDisplayNumber(position.explicitModeledCostsLamports || '0', 9), 0);
    const net = pnl.reduce((sum, value) => sum + value, 0);
    const sorted = [...pnl].sort((a, b) => a - b); const best = sorted.at(-1) || 0;
    const gains = pnl.filter((value) => value > 0).reduce((a, b) => a + b, 0);
    const losses = -pnl.filter((value) => value < 0).reduce((a, b) => a + b, 0);
    const byMint = {};
    for (const position of closed) byMint[position.mint] = (byMint[position.mint] || 0) + atomicToDisplayNumber(position.realizedPnlLamports || '0', 9);
    const hardStops = closed.filter((position) => position.exitReason === 'hard-stop');
    const actualStopReturns = hardStops.map((position) => pctFromRatio(atomic(position.entrySpendLamports) + atomic(position.realizedPnlLamports), atomic(position.entrySpendLamports))).filter((value) => value != null);
    const captured = closed.map((position) => {
      const netPct = pctFromRatio(atomic(position.entrySpendLamports) + atomic(position.realizedPnlLamports), atomic(position.entrySpendLamports));
      return { netPct, mfePct: Number(position.mfePct || 0), capturedPct: Number(position.mfePct || 0) > 0 ? netPct / Number(position.mfePct) * 100 : null, givebackPct: Number(position.mfePct || 0) - netPct };
    });
    return {
      trades: closed.length, grossReturnSol: gross, explicitCostsSol: costs, netReturnSol: net,
      expectancySol: closed.length ? net / closed.length : 0, medianTradeSol: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
      profitFactor: losses ? gains / losses : gains ? null : 0, netExcludingBestSol: net - best,
      bestTradeContributionPct: net ? best / net * 100 : 0, bestTradeSol: best, worstTradeSol: sorted[0] || 0,
      uniqueMints: Object.keys(byMint).length, resultsClusteredByMint: byMint,
      intendedVsActualStop: { intendedStopPct: -this.config.bot.exit.hardStopPct, count: hardStops.length, averageActualNetReturnPct: actualStopReturns.length ? actualStopReturns.reduce((a, b) => a + b, 0) / actualStopReturns.length : null },
      mfeCapture: {
        averageCapturedPct: captured.filter((item) => item.capturedPct != null).length ? captured.filter((item) => item.capturedPct != null).reduce((sum, item) => sum + item.capturedPct, 0) / captured.filter((item) => item.capturedPct != null).length : null,
        averageGivebackPct: captured.length ? captured.reduce((sum, item) => sum + item.givebackPct, 0) / captured.length : null
      },
      walletPosteriors: this._walletPosteriorTable(),
      openCensored: Object.values(this.state.bot.positions).filter((position) => position.quoteDriven).length,
      counterfactualCoverage: { activeWatches: Object.keys(this.state.v3.outcomeWatches).length, horizonsMs: this.config.jupiter.counterfactualHorizonsMs }
    };
  }

  _walletPosteriorTable() {
    const closed = this.state.bot.closedPositions.filter((position) => position.quoteDriven);
    const global = clusteredOutcomes(closed);
    const ess = this.config.bot.brain.priorEquivalentSampleSize;
    const globalTp1 = betaPosterior({ successes: global.filter((item) => item.tp1).length, trials: global.length, priorMean: 0.4, priorEquivalentSampleSize: ess }).mean;
    const globalFinal = betaPosterior({ successes: global.filter((item) => item.final).length, trials: global.length, priorMean: 0.2, priorEquivalentSampleSize: ess }).mean;
    return this.config.wallets.filter((wallet) => wallet.enabled).map((wallet) => {
      const outcomes = clusteredOutcomes(closed, wallet.address);
      return {
        address: wallet.address, label: wallet.label, uniqueMints: outcomes.length, evidenceGrade: evidenceGrade(outcomes.length),
        tp1: betaPosterior({ successes: outcomes.filter((item) => item.tp1).length, trials: outcomes.length, priorMean: globalTp1, priorEquivalentSampleSize: ess }),
        final: betaPosterior({ successes: outcomes.filter((item) => item.final).length, trials: outcomes.length, priorMean: globalFinal, priorEquivalentSampleSize: ess })
      };
    }).filter((wallet) => wallet.uniqueMints > 0).sort((left, right) => right.uniqueMints - left.uniqueMints);
  }

  snapshot(mint = '') {
    const base = super.snapshot(mint);
    const positions = base.botPositions.map((position) => {
      if (!position.quoteDriven) return { ...position, priceQuality: 'REFERENCE_MARK', routeStatus: 'LEGACY_REFERENCE_ONLY' };
      const lot = this.state.lots.find((item) => item.mint === position.mint && item.source === 'jupiter-paper');
      return {
        ...position, exactTokenBalanceAtomic: lot?.remainingTokenAmountAtomic || position.remainingTokenAmountAtomic,
        exactTokenBalanceDisplay: lot ? atomicToDecimalString(lot.remainingTokenAmountAtomic, lot.tokenDecimals) : '',
        reverseQuoteAgeMs: position.lastQuoteAt ? Math.max(0, this.clock() - position.lastQuoteAt) : null,
        currentNetValueSol: position.currentNetValueLamports ? atomicToDisplayNumber(position.currentNetValueLamports, 9) : null,
        unrealizedPnlSol: position.currentNetValueLamports && lot
          ? atomicToDisplayNumber(atomic(position.currentNetValueLamports) - atomic(lot.remainingEntrySpendLamports) - atomic(lot.remainingEntryCostLamports), 9) : null
      };
    });
    const selected = (mint && positions.find((position) => position.mint === mint)) || positions[0] || null;
    const cohortSummary = (cohort) => {
      const value = this.state.v3.counterfactualSummary[cohort] || {};
      return { ...value, averageReturnPct: value.available ? value.sumReturnPct / value.available : null };
    };
    return {
      ...base, strategy: 'PAPER_AGGRESSIVE_BAYES_V1', controlStrategy: 'PAPER_AGGRESSIVE_CONTROL',
      botPosition: selected, botPositions: positions, waldFunnel: {
        ...this.state.v3.cohorts,
        walletBuySignals: this.state.v3.walletBuySignals,
        walletSellSignals: this.state.v3.walletSellSignals,
        candidates: Object.keys(this.state.bot.candidates).length,
        openCensored: Object.values(this.state.bot.positions).filter((position) => position.quoteDriven).length,
        stoppedRecoveries: this.state.v3.stoppedRecoveryIds.length
      },
      observationHealth: this.serviceStatus.observationHealth || {},
      jupiterHealth: this.executionAdapters.BOT_PAPER?.status?.() || { available: false, executionEnabled: false },
      brain: base.candidate?.brain || selected?.brain || null, robustSessionStatistics: this._robustStatistics(),
      counterfactualComparisons: {
        signalledVsUniverse: { signalled: cohortSummary('WALLET_SIGNAL'), universe: cohortSummary('UNIVERSE_CONTROL') },
        enteredVsRejected: { entered: cohortSummary('PAPER_ENTERED'), rejected: cohortSummary('REJECTED') },
        noRouteVsRoutable: { noEntryRoute: cohortSummary('NO_ENTRY_ROUTE'), noSellRoute: cohortSummary('NO_SELL_ROUTE'), routable: cohortSummary('PAPER_ENTERED') },
        stoppedWatch: { outcomes: cohortSummary('STOPPED_WATCH'), recovered15PctFromStop: this.state.v3.stoppedRecoveryIds.length },
        postExitOpportunity: cohortSummary('POST_EXIT_WATCH'),
        alternativeShadowExit: { available: false, reason: 'No alternative exit was promoted from the outlier-dependent legacy sample.' }
      },
      auditStatus: this.auditWriter?.status() || { enabled: false },
      ledgerReconciliation: this.auditWriter?.reconcileV3?.(undefined, this.sessionId) || null,
      v3SchemaVersion: this.state.v3.schemaVersion
    };
  }

  _writeManifest(event) {
    let rpcHostname = '';
    try { rpcHostname = new URL(this.config.rpc.httpUrl).hostname; } catch {}
    const walletHash = sha256(this.config.wallets.filter((wallet) => wallet.enabled).map((wallet) => ({ address: wallet.address, weight: wallet.weight })));
    this.auditWriter?.writeManifest?.({
      session_id: this.sessionId, manifest_id: `${this.sessionId}:${event}`, timestamp_utc: iso(this.clock()), event,
      start_timestamp_utc: event === 'SESSION_START' ? iso(this.clock()) : '', end_timestamp_utc: event === 'SESSION_END' ? iso(this.clock()) : '',
      strategy_version: 'PAPER_AGGRESSIVE_BAYES_V1', control_strategy_version: 'PAPER_AGGRESSIVE_CONTROL',
      config_hash: this.configHash, code_version: this.codeVersion, rpc_hostname: rpcHostname,
      wallet_roster_hash: walletHash, enabled_wallet_count: this.config.wallets.filter((wallet) => wallet.enabled).length,
      jupiter_available: Boolean(this.executionAdapters.BOT_PAPER?.client), paper_taker_configured: Boolean(this.config.jupiter.paperTakerAddress),
      counterfactual_horizons_ms: this.config.jupiter.counterfactualHorizonsMs.join('|'),
      restart_count: Math.max(0, this.state.v3.restartCount - 1), data_gap: this.state.v3.dataGaps > 0,
      notes: `Paper only; signing and transaction submission disabled. Recorded RPC data gaps: ${this.state.v3.dataGaps}.`
    });
  }

  stopAutomation() {
    for (const position of Object.values(this.state.bot.positions)) if (position.quoteDriven) this.recordOutcome('OPEN_CENSORED', {
      mint: position.mint, symbol: position.symbol, decisionId: position.decisionId, positionId: position.positionId,
      snapshotId: position.snapshotId, reason: 'Session ended while position remained open', watch: false,
      key: `OPEN_CENSORED:${this.sessionId}:${position.positionId}`
    });
    this._writeManifest('SESSION_END');
    super.stopAutomation();
  }
}

module.exports = { COHORTS, SurvivorshipPaperEngine, freshV3, pctFromRatio };
