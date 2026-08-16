'use strict';

const { EventEmitter } = require('node:events');
const { applyHaircut, atomic, atomicToDisplayNumber, decimalToAtomic, SOL_MINT } = require('./atomic');

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function initialState(config) {
  return {
    version: 1,
    initialBalanceSol: config.startingBalanceSol,
    balanceSol: config.startingBalanceSol,
    balanceLamports: decimalToAtomic(String(config.startingBalanceSol), 9).toString(),
    realizedPnlSol: 0,
    followEnabled: config.follow.enabledOnStart,
    lots: [],
    closedTrades: [],
    fills: [],
    activity: [],
    riskByMint: {},
    limitOrders: {},
    seenSignals: [],
    nextSequence: 1
  };
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function shortAddress(address) {
  if (!address) return 'unknown';
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hydrateState(raw, config) {
  const fallback = initialState(config);
  if (!raw || raw.version !== 1) return fallback;
  const state = { ...fallback, ...raw };
  state.lots = Array.isArray(raw.lots) ? raw.lots : [];
  state.closedTrades = Array.isArray(raw.closedTrades) ? raw.closedTrades.slice(-5000) : [];
  state.fills = Array.isArray(raw.fills) ? raw.fills.slice(0, 500) : [];
  state.activity = Array.isArray(raw.activity) ? raw.activity.slice(0, 250) : [];
  state.seenSignals = Array.isArray(raw.seenSignals) ? raw.seenSignals.slice(-2000) : [];
  state.riskByMint = raw.riskByMint && typeof raw.riskByMint === 'object' ? raw.riskByMint : {};
  state.limitOrders = raw.limitOrders && typeof raw.limitOrders === 'object' ? raw.limitOrders : {};
  state.nextSequence = Math.max(1, Math.trunc(finite(raw.nextSequence, 1)));
  state.balanceSol = Math.max(0, finite(raw.balanceSol, fallback.balanceSol));
  state.balanceLamports = /^\d+$/.test(String(raw.balanceLamports || ''))
    ? String(raw.balanceLamports)
    : BigInt(Math.max(0, Math.round(state.balanceSol * 1e9))).toString();
  state.realizedPnlSol = finite(raw.realizedPnlSol, 0);
  state.followEnabled = Boolean(raw.followEnabled);
  return state;
}

class PaperEngine extends EventEmitter {
  constructor({ config, store = null, clock = () => Date.now() }) {
    super();
    this.config = config;
    this.store = store;
    this.clock = clock;
    this.state = hydrateState(store?.loadState(), config);
    this.markets = new Map();
    this.pendingSignals = [];
    this.automationLocks = new Set();
    this.executionGeneration = 1;
    this.serviceStatus = {
      rpc: config.wallets.some((wallet) => wallet.enabled) ? 'starting' : 'idle-no-wallets',
      priceFallback: config.priceFallback.enabled ? 'starting' : 'disabled',
      lastRpcEventAt: null,
      lastPriceFallbackAt: null
    };
  }

  _id(prefix) {
    const id = `${prefix}_${this.state.nextSequence}`;
    this.state.nextSequence += 1;
    return id;
  }

  _commit() {
    this.store?.saveState(this.state);
    this.emit('update');
  }

  _record(kind, message, data = {}) {
    const event = {
      id: this._id('event'),
      at: this.clock(),
      kind,
      message,
      ...data
    };
    this.state.activity.unshift(event);
    this.state.activity = this.state.activity.slice(0, 250);
    this.store?.appendEvent(event);
    return event;
  }

  _syncBalanceFromLamports() { this.state.balanceSol = atomicToDisplayNumber(this.state.balanceLamports, 9); }

  _paperCostLamports() {
    return {
      networkFeeLamports: decimalToAtomic(String(this.config.paper.networkFeeSol), 9),
      priorityFeeLamports: decimalToAtomic(String(this.config.paper.priorityFeeSol), 9)
    };
  }

  _buyJupiterAssessment({ mint, symbol = '', assessment, decision = {} }) {
    if (!assessment?.ok || !assessment.entry?.ok || !assessment.reverse?.ok) return { status: 'skipped', reason: assessment?.outcome || 'no-jupiter-round-trip' };
    const entrySpendLamports = atomic(assessment.entry.inputAmountAtomic);
    const tokenAmountAtomic = atomic(assessment.conservativeTokenAtomic);
    const { networkFeeLamports, priorityFeeLamports } = this._paperCostLamports();
    const explicitCostLamports = networkFeeLamports + priorityFeeLamports;
    const totalDebitLamports = entrySpendLamports + explicitCostLamports;
    if (atomic(this.state.balanceLamports) < totalDebitLamports) return { status: 'skipped', reason: 'insufficient-paper-balance' };
    const now = this.clock();
    const lot = {
      id: this._id('lot'), mint, symbol: String(symbol || '').slice(0, 24), source: 'jupiter-paper',
      decisionId: decision.id || '', snapshotId: decision.snapshotId || '', entryAt: now,
      tokenDecimals: Number(assessment.tokenDecimals ?? 0), initialTokenAmountAtomic: tokenAmountAtomic.toString(),
      remainingTokenAmountAtomic: tokenAmountAtomic.toString(), entrySpendLamports: entrySpendLamports.toString(),
      remainingEntrySpendLamports: entrySpendLamports.toString(), entryCostLamports: explicitCostLamports.toString(),
      remainingEntryCostLamports: explicitCostLamports.toString(), entryQuoteId: assessment.entry.quoteId || '',
      entryRequestId: assessment.entry.requestId || '', priceQuality: assessment.entry.priceQuality,
      fillQuality: assessment.entry.priceQuality, pricingUnit: 'JUPITER_REVERSE_SOL',
      initialCostSol: atomicToDisplayNumber(totalDebitLamports, 9), remainingCostSol: atomicToDisplayNumber(totalDebitLamports, 9),
      feesPaidSol: atomicToDisplayNumber(explicitCostLamports, 9), modeledSlippageSol: 0,
      sourceSignalId: decision.id || '', sourceObservedAt: decision.signalObservedAt || null, sourceReceivedAt: decision.decidedAt || null
    };
    this.state.balanceLamports = (atomic(this.state.balanceLamports) - totalDebitLamports).toString(); this._syncBalanceFromLamports();
    this.state.lots.push(lot);
    const fill = {
      id: this._id('fill'), at: now, side: 'buy', mint, symbol: lot.symbol, reason: 'auto-entry',
      decisionId: decision.id || '', snapshotId: decision.snapshotId || '', lotIds: [lot.id],
      inputMint: SOL_MINT, outputMint: mint, inputAmountAtomic: entrySpendLamports.toString(), outputAmountAtomic: tokenAmountAtomic.toString(),
      inputDecimals: 9, outputDecimals: lot.tokenDecimals, quoteId: assessment.entry.quoteId || '',
      quoteRequestId: assessment.entry.requestId || '', router: assessment.entry.router || '',
      priceQuality: assessment.entry.priceQuality, fillQuality: assessment.entry.priceQuality, pricingUnit: 'JUPITER_REVERSE_SOL',
      amountSol: atomicToDisplayNumber(entrySpendLamports, 9), feesSol: atomicToDisplayNumber(explicitCostLamports, 9),
      entrySpendLamports: entrySpendLamports.toString(), networkFeeLamports: networkFeeLamports.toString(),
      priorityFeeLamports: priorityFeeLamports.toString(), totalCostLamports: explicitCostLamports.toString(),
      executionHaircutBps: this.config.jupiter.paperExecutionHaircutBps,
      resultingTokenBalanceAtomic: tokenAmountAtomic.toString(), realizedPnlLamports: '0'
    };
    this.state.fills.unshift(fill); this.state.fills = this.state.fills.slice(0, 500);
    this._record('fill', 'Jupiter-routed paper BUY filled', { mint, fillId: fill.id, amountSol: fill.amountSol, priceQuality: fill.priceQuality });
    this._commit(); return { status: 'filled', fill, lot };
  }

  _sellJupiterQuote({ mint, percent, reason, quote, decision = {} }) {
    if (!quote?.ok || quote.outputMint !== SOL_MINT) return { status: 'skipped', reason: quote?.errorCode || 'no-fresh-reverse-route' };
    const lot = this.state.lots.find((item) => item.mint === mint && item.source === 'jupiter-paper' && atomic(item.remainingTokenAmountAtomic) > 0n);
    if (!lot) return { status: 'skipped', reason: 'no-jupiter-position' };
    const balanceBefore = atomic(lot.remainingTokenAmountAtomic);
    const inputAmountAtomic = atomic(quote.inputAmountAtomic);
    if (inputAmountAtomic <= 0n || inputAmountAtomic > balanceBefore) return { status: 'skipped', reason: 'reverse-quote-amount-mismatch' };
    const grossOutputLamports = applyHaircut(quote.outAmountAtomic, this.config.jupiter.paperExecutionHaircutBps);
    const { networkFeeLamports, priorityFeeLamports } = this._paperCostLamports();
    const exitCostLamports = networkFeeLamports + priorityFeeLamports;
    const netReceivedLamports = grossOutputLamports > exitCostLamports ? grossOutputLamports - exitCostLamports : 0n;
    const allocatedSpendLamports = atomic(lot.remainingEntrySpendLamports) * inputAmountAtomic / balanceBefore;
    const allocatedEntryCostLamports = atomic(lot.remainingEntryCostLamports) * inputAmountAtomic / balanceBefore;
    const realizedPnlLamports = netReceivedLamports - allocatedSpendLamports - allocatedEntryCostLamports;
    lot.remainingTokenAmountAtomic = (balanceBefore - inputAmountAtomic).toString();
    lot.remainingEntrySpendLamports = (atomic(lot.remainingEntrySpendLamports) - allocatedSpendLamports).toString();
    lot.remainingEntryCostLamports = (atomic(lot.remainingEntryCostLamports) - allocatedEntryCostLamports).toString();
    lot.remainingCostSol = atomicToDisplayNumber(atomic(lot.remainingEntrySpendLamports) + atomic(lot.remainingEntryCostLamports), 9);
    this.state.balanceLamports = (atomic(this.state.balanceLamports) + netReceivedLamports).toString(); this._syncBalanceFromLamports();
    this.state.realizedPnlSol += atomicToDisplayNumber(realizedPnlLamports, 9);
    const now = this.clock();
    const closedTrade = {
      id: this._id('trade'), mint, symbol: lot.symbol, source: lot.source, entryAt: lot.entryAt, exitAt: now,
      holdMs: now - lot.entryAt, costSol: atomicToDisplayNumber(allocatedSpendLamports + allocatedEntryCostLamports, 9),
      proceedsSol: atomicToDisplayNumber(netReceivedLamports, 9), pnlSol: atomicToDisplayNumber(realizedPnlLamports, 9),
      pnlPct: allocatedSpendLamports + allocatedEntryCostLamports > 0n ? Number(realizedPnlLamports * 1_000_000n / (allocatedSpendLamports + allocatedEntryCostLamports)) / 10_000 : 0,
      fraction: Number(percent) / 100, reason, decisionId: decision.id || '', snapshotId: lot.snapshotId,
      inputAmountAtomic: inputAmountAtomic.toString(), outputAmountLamports: grossOutputLamports.toString()
    };
    this.state.closedTrades.push(closedTrade); this.state.closedTrades = this.state.closedTrades.slice(-5000);
    if (atomic(lot.remainingTokenAmountAtomic) === 0n) this.state.lots = this.state.lots.filter((item) => item !== lot);
    const fill = {
      id: this._id('fill'), at: now, side: 'sell', mint, symbol: lot.symbol, reason, percent: Number(percent),
      decisionId: decision.id || '', snapshotId: lot.snapshotId, lotIds: [lot.id], inputMint: mint, outputMint: SOL_MINT,
      inputAmountAtomic: inputAmountAtomic.toString(), outputAmountAtomic: grossOutputLamports.toString(), inputDecimals: lot.tokenDecimals, outputDecimals: 9,
      quoteId: quote.quoteId || '', quoteRequestId: quote.requestId || '', router: quote.router || '',
      priceQuality: quote.priceQuality, fillQuality: quote.priceQuality, pricingUnit: 'JUPITER_REVERSE_SOL',
      amountSol: atomicToDisplayNumber(grossOutputLamports, 9), netProceedsSol: atomicToDisplayNumber(netReceivedLamports, 9),
      feesSol: atomicToDisplayNumber(exitCostLamports, 9), realizedPnlSol: atomicToDisplayNumber(realizedPnlLamports, 9),
      allocatedEntrySpendLamports: allocatedSpendLamports.toString(), networkFeeLamports: networkFeeLamports.toString(),
      priorityFeeLamports: priorityFeeLamports.toString(), totalCostLamports: exitCostLamports.toString(),
      executionHaircutBps: this.config.jupiter.paperExecutionHaircutBps,
      resultingTokenBalanceAtomic: lot.remainingTokenAmountAtomic, realizedPnlLamports: realizedPnlLamports.toString()
    };
    this.state.fills.unshift(fill); this.state.fills = this.state.fills.slice(0, 500);
    this._record('fill', 'Jupiter-routed paper SELL filled', { mint, fillId: fill.id, realizedPnlSol: fill.realizedPnlSol, priceQuality: fill.priceQuality });
    this._commit(); return { status: 'filled', fill, closedTrades: [closedTrade] };
  }

  setServiceStatus(patch) {
    this.serviceStatus = { ...this.serviceStatus, ...patch };
    this.emit('update');
  }

  getActiveMints() {
    this._prunePendingSignals();
    return [...new Set([
      ...this.state.lots.map((lot) => lot.mint),
      ...this.pendingSignals.map((item) => item.signal.mint),
      ...Object.keys(this.state.limitOrders)
    ])];
  }

  _prunePendingSignals() {
    const now = this.clock();
    const expired = this.pendingSignals.filter((item) => item.expiresAt < now);
    if (!expired.length) return;
    this.pendingSignals = this.pendingSignals.filter((item) => item.expiresAt >= now);
    for (const item of expired) {
      this._record('signal-expired', `No usable price arrived for ${shortAddress(item.signal.mint)}`, {
        mint: item.signal.mint,
        wallet: item.signal.wallet,
        signalId: item.signal.id
      });
    }
    this._commit();
  }

  setMarket(input) {
    const mint = String(input?.mint || '').trim();
    const priceUsd = finite(input?.priceUsd);
    const marketCapUsd = finite(input?.marketCapUsd);
    if (!ADDRESS_RE.test(mint) || (!(priceUsd > 0) && !(marketCapUsd > 0))) {
      return { status: 'ignored', reason: 'invalid-market' };
    }

    const observedAt = finite(input.observedAt, this.clock());
    const existing = this.markets.get(mint);
    const source = String(input.source || 'unknown');
    const market = {
      mint,
      symbol: String(input.symbol || existing?.symbol || '').slice(0, 24),
      priceUsd: priceUsd > 0 ? priceUsd : null,
      priceSol: finite(input.priceSol),
      marketCapUsd: marketCapUsd > 0 ? marketCapUsd : existing?.marketCapUsd ?? null,
      supply: finite(input.supply, existing?.supply ?? null),
      source,
      observedAt,
      receivedAt: this.clock()
    };
    this.markets.set(mint, market);

    const now = this.clock();
    const ready = [];
    this.pendingSignals = this.pendingSignals.filter((item) => {
      if (item.expiresAt < now) {
        this._record('signal-expired', `No usable price arrived for ${shortAddress(item.signal.mint)}`, {
          mint: item.signal.mint,
          wallet: item.signal.wallet,
          signalId: item.signal.id
        });
        return false;
      }
      if (item.signal.mint === mint) {
        ready.push(item.signal);
        return false;
      }
      return true;
    });
    for (const signal of ready) this._scheduleSignal(signal);
    this._checkAutomations(mint);
    this.emit('update');
    return { status: 'accepted', market };
  }

  _freshMarket(mint) {
    const market = this.markets.get(mint);
    if (!market) return null;
    return this.clock() - market.receivedAt <= this.config.paper.maxPriceAgeMs ? market : null;
  }

  _wallet(address) {
    return this.config.wallets.find((wallet) => wallet.enabled && wallet.address === address) || null;
  }

  _signalAllowed(signal) {
    const enabledWallets = this.config.wallets.filter((wallet) => wallet.enabled);
    if (enabledWallets.length) return Boolean(this._wallet(signal.wallet));
    return this.config.follow.acceptVisibleWalletsWhenListEmpty || signal.source !== 'gmgn-page';
  }

  async handleSignal(input) {
    const side = String(input?.side || '').toLowerCase();
    const mint = String(input?.mint || '').trim();
    const wallet = String(input?.wallet || '').trim();
    if (!['buy', 'sell'].includes(side) || !ADDRESS_RE.test(mint) || !ADDRESS_RE.test(wallet)) {
      return { status: 'ignored', reason: 'invalid-signal' };
    }

    const id = String(input.id || input.signature || `${wallet}:${mint}:${side}:${finite(input.observedAt, this.clock())}`);
    if (this.state.seenSignals.includes(id)) return { status: 'duplicate', id };
    this.state.seenSignals.push(id);
    this.state.seenSignals = this.state.seenSignals.slice(-2000);

    const signal = {
      id,
      signature: String(input.signature || ''),
      side,
      mint,
      wallet,
      walletLabel: String(input.walletLabel || this._wallet(wallet)?.label || shortAddress(wallet)),
      fraction: finite(input.fraction),
      sourcePriceUsd: finite(input.sourcePriceUsd),
      sourcePriceSol: finite(input.sourcePriceSol),
      source: String(input.source || 'rpc'),
      observedAt: finite(input.observedAt, this.clock()),
      receivedAt: this.clock()
    };
    this._record('signal', `${signal.walletLabel} ${side.toUpperCase()} detected`, {
      side,
      mint,
      wallet,
      signalId: id,
      signature: signal.signature
    });

    if (!this._signalAllowed(signal)) {
      this._record('signal-filtered', `Ignored untracked wallet ${shortAddress(wallet)}`, { mint, wallet, signalId: id });
      this._commit();
      return { status: 'filtered', id };
    }
    if (!this.state.followEnabled) {
      this._commit();
      return { status: 'observed', id, followEnabled: false };
    }
    if (side === 'buy' && this.state.lots.length >= this.config.follow.maxOpenLots) {
      this._record('signal-skipped', 'Open paper-lot cap reached', { mint, wallet, signalId: id });
      this._commit();
      return { status: 'skipped', reason: 'lot-cap', id };
    }

    if (!this._freshMarket(mint)) {
      this.pendingSignals.push({
        signal,
        expiresAt: this.clock() + this.config.paper.maxPriceAgeMs
      });
      this._record('awaiting-price', `Waiting for a live ${shortAddress(mint)} price`, { mint, wallet, signalId: id });
      this._commit();
      return { status: 'awaiting-price', id };
    }
    this._commit();
    return this._scheduleSignal(signal);
  }

  _scheduleSignal(signal) {
    const delay = this.config.paper.latencyMs;
    const generation = this.executionGeneration;
    if (delay <= 0) return Promise.resolve(this._executeFollowSignal(signal, generation));
    this._record('pending-fill', `${delay}ms paper execution delay`, {
      mint: signal.mint,
      wallet: signal.wallet,
      signalId: signal.id
    });
    this._commit();
    return new Promise((resolve) => {
      setTimeout(() => resolve(this._executeFollowSignal(signal, generation)), delay);
    });
  }

  _executeFollowSignal(signal, generation = this.executionGeneration) {
    if (generation !== this.executionGeneration || !this.state.followEnabled) {
      this._record('fill-cancelled', 'Queued follow fill was cancelled', {
        mint: signal.mint,
        wallet: signal.wallet,
        signalId: signal.id
      });
      this._commit();
      return { status: 'cancelled', reason: 'follow-paused-or-reset' };
    }
    const market = this._freshMarket(signal.mint);
    if (!market) {
      this._record('fill-skipped', 'Price became stale before paper fill', {
        mint: signal.mint,
        wallet: signal.wallet,
        signalId: signal.id
      });
      this._commit();
      return { status: 'skipped', reason: 'stale-price' };
    }
    if (signal.side === 'buy') {
      return this._buy({
        mint: signal.mint,
        symbol: market.symbol,
        amountSol: this.config.follow.orderSolPerWallet,
        reason: 'follow-entry',
        sourceWallet: signal.wallet,
        sourceWalletLabel: signal.walletLabel,
        sourceSignalId: signal.id,
        sourceSignature: signal.signature,
        sourceObservedAt: signal.observedAt,
        sourceReceivedAt: signal.receivedAt,
        sourcePriceUsd: signal.sourcePriceUsd,
        sourcePriceSol: signal.sourcePriceSol
      });
    }
    const lots = this.state.lots.filter((lot) => lot.mint === signal.mint && lot.sourceWallet === signal.wallet);
    if (!lots.length) {
      this._record('unmatched-exit', `${signal.walletLabel} sold without an open followed lot`, {
        mint: signal.mint,
        wallet: signal.wallet,
        signalId: signal.id
      });
      this._commit();
      return { status: 'unmatched-exit' };
    }
    const fraction = signal.fraction && signal.fraction > 0 ? clamp(signal.fraction, 0.000001, 1) : 1;
    return this._sellLots({
      mint: signal.mint,
      lots,
      fraction,
      reason: 'follow-exit',
      sourceWallet: signal.wallet,
      sourceSignalId: signal.id,
      sourceSignature: signal.signature,
      sourceObservedAt: signal.observedAt,
      sourceReceivedAt: signal.receivedAt
    });
  }

  manualBuy({ mint, amountSol, symbol = '' }) {
    return this._buy({ mint, amountSol, symbol, reason: 'manual-entry' });
  }

  manualSell({ mint, percent }) {
    const fraction = clamp(finite(percent, 100) / 100, 0.000001, 1);
    const lots = this.state.lots.filter((lot) => lot.mint === mint);
    if (!lots.length) return { status: 'skipped', reason: 'no-position' };
    return this._sellLots({ mint, lots, fraction, reason: 'manual-exit' });
  }

  _buy({ mint, amountSol, symbol = '', reason, sourceWallet = '', sourceWalletLabel = '', sourceSignalId = '', sourceSignature = '', sourceObservedAt = null, sourceReceivedAt = null, sourcePriceUsd = null, sourcePriceSol = null, additionalFeeSol = 0 }) {
    const market = this._freshMarket(mint);
    const amount = finite(amountSol);
    if (!ADDRESS_RE.test(String(mint || '')) || !market) return { status: 'skipped', reason: 'no-fresh-price' };
    if (!amount || amount <= 0) return { status: 'skipped', reason: 'invalid-amount' };

    const platformFee = amount * this.config.paper.platformFeeBps / 10_000;
    const quoteFee = Math.max(0, finite(additionalFeeSol, 0));
    const txFee = this.config.paper.networkFeeSol + this.config.paper.priorityFeeSol + quoteFee;
    const totalDebit = amount + txFee;
    if (this.state.balanceSol + 1e-12 < totalDebit) {
      this._record('fill-skipped', 'Insufficient paper balance', { mint, amountSol: amount, reason });
      this._commit();
      return { status: 'skipped', reason: 'insufficient-paper-balance' };
    }

    const proxyOnly = !(market.priceUsd > 0) && market.marketCapUsd > 0;
    const executionPriceUsd = proxyOnly ? null : market.priceUsd * (1 + this.config.paper.slippageBps / 10_000);
    const pricingUnit = proxyOnly ? 'MARKET_CAP_RATIO' : market.priceSol && market.priceSol > 0 ? 'SOL' : 'USD_RATIO';
    const fillQuality = proxyOnly ? 'PROXY_ONLY' : 'EXECUTABLE_PRICE';
    const observedIndexPrice = proxyOnly ? market.marketCapUsd : pricingUnit === 'SOL' ? market.priceSol : market.priceUsd;
    const executionIndexPrice = observedIndexPrice * (1 + this.config.paper.slippageBps / 10_000);
    const quantityIndex = (amount - platformFee) / executionIndexPrice;
    const now = this.clock();
    const lot = {
      id: this._id('lot'),
      mint,
      symbol: String(symbol || market.symbol || '').slice(0, 24),
      source: reason.startsWith('follow') ? 'follow' : 'manual',
      sourceWallet,
      sourceWalletLabel,
      sourceSignalId,
      sourceSignature,
      sourceObservedAt,
      sourceReceivedAt,
      sourcePriceUsd: finite(sourcePriceUsd),
      sourcePriceSol: finite(sourcePriceSol),
      detectionToFillMs: sourceObservedAt ? Math.max(0, now - sourceObservedAt) : null,
      detectionToDecisionMs: sourceObservedAt && sourceReceivedAt ? Math.max(0, sourceReceivedAt - sourceObservedAt) : null,
      decisionToFillMs: sourceReceivedAt ? Math.max(0, now - sourceReceivedAt) : null,
      entryAt: now,
      entryObservedPriceUsd: market.priceUsd || null,
      entryExecutionPriceUsd: executionPriceUsd,
      pricingUnit,
      fillQuality,
      entryObservedIndexPrice: observedIndexPrice,
      entryExecutionIndexPrice: executionIndexPrice,
      entrySolUsd: pricingUnit === 'SOL' ? market.priceUsd / market.priceSol : null,
      initialQuantityIndex: quantityIndex,
      remainingQuantityIndex: quantityIndex,
      initialCostSol: totalDebit,
      remainingCostSol: totalDebit,
      feesPaidSol: platformFee + txFee,
      quoteFeeSol: quoteFee,
      modeledSlippageSol: amount * this.config.paper.slippageBps / 10_000
    };
    this.state.balanceSol -= totalDebit;
    this.state.lots.push(lot);
    const fill = {
      id: this._id('fill'),
      at: now,
      side: 'buy',
      mint,
      symbol: lot.symbol,
      reason,
      sourceWallet,
      sourceSignalId,
      sourceSignature,
      sourceObservedAt,
      observedPriceUsd: market.priceUsd || null,
      executionPriceUsd,
      observedPriceOrIndex: observedIndexPrice,
      executionPriceOrIndex: executionIndexPrice,
      pricingUnit,
      fillQuality,
      amountSol: amount,
      feesSol: platformFee + txFee,
      quoteFeeSol: quoteFee,
      modeledSlippageSol: amount * this.config.paper.slippageBps / 10_000,
      lotIds: [lot.id]
    };
    this.state.fills.unshift(fill);
    this.state.fills = this.state.fills.slice(0, 500);
    this._record('fill', `${reason === 'follow-entry' ? 'Followed' : 'Manual'} paper BUY filled`, {
      mint,
      side: 'buy',
      wallet: sourceWallet,
      fillId: fill.id,
      amountSol: amount
    });
    this._commit();
    return { status: 'filled', fill, lot };
  }

  _sellLots({ mint, lots, fraction, reason, sourceWallet = '', sourceSignalId = '', sourceSignature = '', sourceObservedAt = null, sourceReceivedAt = null, additionalFeeSol = 0 }) {
    const market = this._freshMarket(mint);
    if (!market) return { status: 'skipped', reason: 'no-fresh-price' };
    const selected = lots.filter((lot) => this.state.lots.includes(lot) && lot.remainingQuantityIndex > 0);
    if (!selected.length) return { status: 'skipped', reason: 'no-position' };

    const normalizedFraction = clamp(finite(fraction, 1), 0.000001, 1);
    const proxyOnly = selected[0].pricingUnit === 'MARKET_CAP_RATIO';
    const observedExitIndex = proxyOnly ? market.marketCapUsd : market.priceUsd;
    const executionPriceUsd = proxyOnly ? null : market.priceUsd * (1 - this.config.paper.slippageBps / 10_000);
    const quantities = selected.map((lot) => lot.remainingQuantityIndex * normalizedFraction);
    const totalQuantity = quantities.reduce((sum, value) => sum + value, 0);
    const grossByLot = selected.map((lot, index) => {
      const currentIndexPrice = lot.pricingUnit === 'SOL'
        ? market.priceSol || (lot.entrySolUsd ? market.priceUsd / lot.entrySolUsd : null)
        : lot.pricingUnit === 'MARKET_CAP_RATIO'
          ? market.marketCapUsd
        : market.priceUsd;
      return currentIndexPrice ? quantities[index] * currentIndexPrice * (1 - this.config.paper.slippageBps / 10_000) : 0;
    });
    const grossProceeds = grossByLot.reduce((sum, value) => sum + value, 0);
    const platformFee = grossProceeds * this.config.paper.platformFeeBps / 10_000;
    const quoteFee = Math.max(0, finite(additionalFeeSol, 0));
    const txFee = this.config.paper.networkFeeSol + this.config.paper.priorityFeeSol + quoteFee;
    const netProceeds = Math.max(0, grossProceeds - platformFee - txFee);
    const now = this.clock();
    let realizedPnlSol = 0;
    const closed = [];

    selected.forEach((lot, index) => {
      const quantity = quantities[index];
      const share = grossProceeds > 0 ? grossByLot[index] / grossProceeds : totalQuantity > 0 ? quantity / totalQuantity : 0;
      const proceeds = netProceeds * share;
      const allocatedCost = lot.remainingCostSol * normalizedFraction;
      const pnlSol = proceeds - allocatedCost;
      realizedPnlSol += pnlSol;
      lot.remainingQuantityIndex -= quantity;
      lot.remainingCostSol -= allocatedCost;
      if (lot.remainingQuantityIndex < 1e-16 || normalizedFraction > 0.999999) {
        lot.remainingQuantityIndex = 0;
        lot.remainingCostSol = 0;
      }
      const closedTrade = {
        id: this._id('trade'),
        mint,
        symbol: lot.symbol,
        source: lot.source,
        sourceWallet: lot.sourceWallet,
        sourceWalletLabel: lot.sourceWalletLabel,
        entrySignalId: lot.sourceSignalId,
        exitSignalId: sourceSignalId,
        entrySignature: lot.sourceSignature,
        exitSignature: sourceSignature,
        entrySignalObservedAt: lot.sourceObservedAt,
        entrySignalReceivedAt: lot.sourceReceivedAt,
        entryDetectionToFillMs: lot.detectionToFillMs,
        entryDetectionToDecisionMs: lot.detectionToDecisionMs,
        entryDecisionToFillMs: lot.decisionToFillMs,
        sourceEntryPriceUsd: lot.sourcePriceUsd,
        sourceEntryPriceSol: lot.sourcePriceSol,
        exitSignalObservedAt: sourceObservedAt,
        exitSignalReceivedAt: sourceReceivedAt,
        exitDetectionToFillMs: sourceObservedAt ? Math.max(0, now - sourceObservedAt) : null,
        entryAt: lot.entryAt,
        exitAt: now,
        holdMs: now - lot.entryAt,
        entryPriceUsd: lot.entryExecutionPriceUsd,
        exitPriceUsd: executionPriceUsd,
        exitPriceOrIndex: proxyOnly ? market.marketCapUsd * (1 - this.config.paper.slippageBps / 10_000) : executionPriceUsd,
        costSol: allocatedCost,
        proceedsSol: proceeds,
        pnlSol,
        pnlPct: allocatedCost > 0 ? pnlSol / allocatedCost * 100 : 0,
        fraction: normalizedFraction,
        reason
      };
      this.state.closedTrades.push(closedTrade);
      closed.push(closedTrade);
    });

    this.state.lots = this.state.lots.filter((lot) => lot.remainingQuantityIndex > 0);
    this.state.closedTrades = this.state.closedTrades.slice(-5000);
    this.state.balanceSol += netProceeds;
    this.state.realizedPnlSol += realizedPnlSol;
    const fill = {
      id: this._id('fill'),
      at: now,
      side: 'sell',
      mint,
      symbol: selected[0].symbol,
      reason,
      sourceWallet,
      sourceSignalId,
      sourceSignature,
      sourceObservedAt,
      observedPriceUsd: market.priceUsd || null,
      executionPriceUsd,
      observedPriceOrIndex: observedExitIndex,
      executionPriceOrIndex: observedExitIndex ? observedExitIndex * (1 - this.config.paper.slippageBps / 10_000) : null,
      pricingUnit: selected[0].pricingUnit,
      fillQuality: selected[0].fillQuality || (proxyOnly ? 'PROXY_ONLY' : 'EXECUTABLE_PRICE'),
      amountSol: grossProceeds,
      netProceedsSol: netProceeds,
      feesSol: platformFee + txFee,
      quoteFeeSol: quoteFee,
      modeledSlippageSol: grossProceeds * this.config.paper.slippageBps / Math.max(1, 10_000 - this.config.paper.slippageBps),
      realizedPnlSol,
      percent: normalizedFraction * 100,
      lotIds: selected.map((lot) => lot.id)
    };
    this.state.fills.unshift(fill);
    this.state.fills = this.state.fills.slice(0, 500);
    this._record('fill', `${reason === 'follow-exit' ? 'Followed' : 'Paper'} SELL filled`, {
      mint,
      side: 'sell',
      wallet: sourceWallet,
      fillId: fill.id,
      realizedPnlSol
    });
    this._commit();
    return { status: 'filled', fill, closedTrades: closed };
  }

  setFollow(enabled) {
    this.state.followEnabled = Boolean(enabled);
    if (!this.state.followEnabled) {
      this.executionGeneration += 1;
      this.pendingSignals = [];
    }
    this._record('follow', `Follow test ${this.state.followEnabled ? 'enabled' : 'paused'}`);
    this._commit();
    return { status: 'ok', followEnabled: this.state.followEnabled };
  }

  setRisk({ mint, takeProfitPct, stopLossPct }) {
    if (!ADDRESS_RE.test(String(mint || ''))) return { status: 'ignored', reason: 'invalid-mint' };
    const takeProfit = finite(takeProfitPct);
    const stopLoss = finite(stopLossPct);
    if ((!takeProfit || takeProfit <= 0) && (!stopLoss || stopLoss <= 0)) delete this.state.riskByMint[mint];
    else {
      this.state.riskByMint[mint] = {
        takeProfitPct: takeProfit && takeProfit > 0 ? takeProfit : null,
        stopLossPct: stopLoss && stopLoss > 0 ? stopLoss : null
      };
    }
    this._record('risk', 'Paper take-profit / stop-loss updated', { mint, ...this.state.riskByMint[mint] });
    this._commit();
    return { status: 'ok', risk: this.state.riskByMint[mint] || null };
  }

  setLimit({ mint, targetPriceUsd, amountSol, symbol = '' }) {
    const target = finite(targetPriceUsd);
    const amount = finite(amountSol, this.config.defaultOrderSol);
    if (!ADDRESS_RE.test(String(mint || '')) || !target || target <= 0 || !amount || amount <= 0) {
      return { status: 'ignored', reason: 'invalid-limit' };
    }
    this.state.limitOrders[mint] = {
      id: this._id('limit'),
      mint,
      symbol,
      targetPriceUsd: target,
      amountSol: amount,
      createdAt: this.clock()
    };
    this._record('limit', 'Paper limit buy armed', { mint, targetPriceUsd: target, amountSol: amount });
    this._commit();
    return { status: 'ok', order: this.state.limitOrders[mint] };
  }

  cancelLimit(mint) {
    const existed = Boolean(this.state.limitOrders[mint]);
    delete this.state.limitOrders[mint];
    if (existed) this._record('limit', 'Paper limit buy cancelled', { mint });
    this._commit();
    return { status: 'ok', existed };
  }

  _checkAutomations(mint) {
    const market = this._freshMarket(mint);
    if (!market || this.automationLocks.has(mint)) return;
    const limit = this.state.limitOrders[mint];
    if (limit && market.priceUsd <= limit.targetPriceUsd) {
      this.automationLocks.add(mint);
      delete this.state.limitOrders[mint];
      const generation = this.executionGeneration;
      setTimeout(() => {
        if (generation !== this.executionGeneration) return;
        this._buy({ mint, amountSol: limit.amountSol, symbol: limit.symbol, reason: 'limit-entry' });
        this.automationLocks.delete(mint);
      }, this.config.paper.latencyMs);
      return;
    }

    const risk = this.state.riskByMint[mint];
    const position = this.positionFor(mint);
    if (!risk || !position || position.remainingCostSol <= 0) return;
    const pnlPct = position.unrealizedPnlPct;
    const reason = risk.takeProfitPct && pnlPct >= risk.takeProfitPct
      ? 'take-profit'
      : risk.stopLossPct && pnlPct <= -risk.stopLossPct
        ? 'stop-loss'
        : null;
    if (!reason) return;
    this.automationLocks.add(mint);
    const generation = this.executionGeneration;
    setTimeout(() => {
      if (generation !== this.executionGeneration) return;
      const lots = this.state.lots.filter((lot) => lot.mint === mint);
      this._sellLots({ mint, lots, fraction: 1, reason });
      this.automationLocks.delete(mint);
    }, this.config.paper.latencyMs);
  }

  positionFor(mint) {
    const lots = this.state.lots.filter((lot) => lot.mint === mint);
    if (!lots.length) return null;
    const market = this.markets.get(mint);
    const remainingCostSol = lots.reduce((sum, lot) => sum + lot.remainingCostSol, 0);
    const remainingQuantityIndex = lots.reduce((sum, lot) => sum + lot.remainingQuantityIndex, 0);
    const estimatedGrossSol = market
      ? lots.reduce((sum, lot) => {
          const currentIndexPrice = lot.pricingUnit === 'SOL'
            ? market.priceSol || (lot.entrySolUsd ? market.priceUsd / lot.entrySolUsd : null)
            : lot.pricingUnit === 'MARKET_CAP_RATIO'
              ? market.marketCapUsd
            : market.priceUsd;
          return sum + (currentIndexPrice ? lot.remainingQuantityIndex * currentIndexPrice : lot.remainingCostSol);
        }, 0)
      : remainingCostSol;
    const estimatedFeesSol = estimatedGrossSol * this.config.paper.platformFeeBps / 10_000
      + this.config.paper.networkFeeSol
      + this.config.paper.priorityFeeSol;
    const estimatedValueSol = Math.max(0, estimatedGrossSol - estimatedFeesSol);
    const unrealizedPnlSol = estimatedValueSol - remainingCostSol;
    return {
      mint,
      symbol: lots.find((lot) => lot.symbol)?.symbol || market?.symbol || '',
      lotCount: lots.length,
      followedWalletCount: new Set(lots.filter((lot) => lot.sourceWallet).map((lot) => lot.sourceWallet)).size,
      remainingCostSol,
      estimatedValueSol,
      unrealizedPnlSol,
      unrealizedPnlPct: remainingCostSol > 0 ? unrealizedPnlSol / remainingCostSol * 100 : 0,
      averageEntryPriceUsd: lots.every((lot) => lot.entryExecutionPriceUsd) ? lots.reduce((sum, lot) => sum + lot.entryExecutionPriceUsd * lot.remainingCostSol, 0) / remainingCostSol : null,
      averageEntryIndex: lots.reduce((sum, lot) => sum + lot.entryExecutionIndexPrice * lot.remainingCostSol, 0) / remainingCostSol,
      currentPriceUsd: market?.priceUsd || null,
      currentPriceOrIndex: lots[0]?.pricingUnit === 'MARKET_CAP_RATIO' ? market?.marketCapUsd || null : market?.priceUsd || null,
      pricingUnit: lots[0]?.pricingUnit || null,
      fillQuality: lots[0]?.fillQuality || null,
      priceSource: market?.source || null,
      priceAgeMs: market ? Math.max(0, this.clock() - market.receivedAt) : null,
      risk: this.state.riskByMint[mint] || null,
      limitOrder: this.state.limitOrders[mint] || null,
      lots: lots.map((lot) => ({
        id: lot.id,
        source: lot.source,
        sourceWallet: lot.sourceWallet,
        sourceWalletLabel: lot.sourceWalletLabel,
        entryAt: lot.entryAt,
        remainingCostSol: lot.remainingCostSol,
        entryPriceUsd: lot.entryExecutionPriceUsd
      }))
    };
  }

  snapshot(mint = '') {
    this._prunePendingSignals();
    const positions = [...new Set(this.state.lots.map((lot) => lot.mint))]
      .map((positionMint) => this.positionFor(positionMint))
      .filter(Boolean);
    const unrealizedPnlSol = positions.reduce((sum, position) => sum + position.unrealizedPnlSol, 0);
    const estimatedPositionsValueSol = positions.reduce((sum, position) => sum + position.estimatedValueSol, 0);
    const closed = this.state.closedTrades;
    const winners = closed.filter((trade) => trade.pnlSol > 0).length;
    const market = mint ? this.markets.get(mint) || null : null;
    return {
      ok: true,
      mode: 'paper',
      strategy: this.config.follow.mode,
      simulation: {
        slippageBps: this.config.paper.slippageBps,
        platformFeeBps: this.config.paper.platformFeeBps,
        networkFeeSol: this.config.paper.networkFeeSol,
        priorityFeeSol: this.config.paper.priorityFeeSol,
        latencyMs: this.config.paper.latencyMs,
        followOrderSol: this.config.follow.orderSolPerWallet
      },
      followEnabled: this.state.followEnabled,
      balanceSol: this.state.balanceSol,
      equitySol: this.state.balanceSol + estimatedPositionsValueSol,
      realizedPnlSol: this.state.realizedPnlSol,
      unrealizedPnlSol,
      initialBalanceSol: this.state.initialBalanceSol,
      position: mint ? this.positionFor(mint) : null,
      positions,
      latestMarket: market,
      limitOrder: mint ? this.state.limitOrders[mint] || null : null,
      risk: mint ? this.state.riskByMint[mint] || null : null,
      stats: {
        openLots: this.state.lots.length,
        closedLots: closed.length,
        wins: winners,
        losses: closed.length - winners,
        winRatePct: closed.length ? winners / closed.length * 100 : 0,
        medianPnlPct: median(closed.map((trade) => trade.pnlPct)),
        trackedWallets: this.config.wallets.filter((wallet) => wallet.enabled).length,
        awaitingPrice: this.pendingSignals.length
      },
      serviceStatus: this.serviceStatus,
      activity: this.state.activity.slice(0, 40),
      fills: this.state.fills.slice(0, 40),
      recentClosedTrades: closed.slice(-40).reverse(),
      serverTime: this.clock()
    };
  }

  reset() {
    this.executionGeneration += 1;
    this.state = initialState(this.config);
    this.pendingSignals = [];
    this.markets.clear();
    this.automationLocks.clear();
    this._record('reset', 'Paper account reset');
    this._commit();
    return { status: 'ok' };
  }

  exportClosedTradesCsv() {
    const headers = [
      'id', 'mint', 'symbol', 'source', 'sourceWallet', 'entryAt', 'exitAt', 'holdMs',
      'entryPriceUsd', 'exitPriceUsd', 'costSol', 'proceedsSol', 'pnlSol', 'pnlPct',
      'fraction', 'reason', 'entryDetectionToFillMs', 'entryDetectionToDecisionMs', 'entryDecisionToFillMs', 'exitDetectionToFillMs',
      'sourceEntryPriceUsd', 'sourceEntryPriceSol', 'entrySignature', 'exitSignature'
    ];
    const quote = (value) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [
      headers.join(','),
      ...this.state.closedTrades.map((trade) => headers.map((header) => quote(trade[header])).join(','))
    ].join('\n') + '\n';
  }
}

module.exports = { ADDRESS_RE, PaperEngine, initialState };
