'use strict';

const { TokenBucket, percentile } = require('./jupiter-client');
const { hasSwapInstruction, parseWalletSwaps } = require('./solana-parser');

function looksLikeSwapLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) return true;
  const text = logs.join('\n');
  return /Instruction:\s*(?:Swap|Buy|Sell|Route|SharedAccountsRoute|ExactOut|ExactIn)|ray_log|SwapEvent|swap_base_|swap_v2|swap2/i.test(text);
}

class SolanaWalletMonitor {
  constructor({
    config, onSignal, onStatus = () => {}, onEvidence = () => {}, cursorStore = null,
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, clock = () => Date.now(),
    random = Math.random, waitImpl
  }) {
    this.config = config; this.onSignal = onSignal; this.onStatus = onStatus; this.onEvidence = onEvidence;
    this.cursorStore = cursorStore; this.fetch = fetchImpl; this.WebSocketImpl = WebSocketImpl;
    this.clock = clock; this.random = random; this.wait = waitImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.socket = null; this.stopped = true; this.requestId = 1;
    this.pendingSubscriptions = new Map(); this.subscriptionWallets = new Map();
    this.seenNotifications = new Set(); this.seenGlobalSignatures = new Set(); this.transactionPromises = new Map();
    this.latestSignatureByWallet = new Map(Object.entries(cursorStore?.loadWalletCursors?.() || {}).map(([wallet, value]) => [wallet, value.signature || value]));
    this.cursorSlots = new Map(Object.entries(cursorStore?.loadWalletCursors?.() || {}).map(([wallet, value]) => [wallet, Number(value.slot || 0)]));
    this.reconnectAttempt = 0; this.reconnectTimer = null; this.confirmationTimers = new Set();
    this.cursorPersistTimer = null;
    this.queue = []; this.activeFetches = 0;
    this.rpcBackoffUntil = 0; this.consecutiveRateLimits = 0;
    this.walletOutcomes = new Map(); this.walletQuarantineUntil = new Map();
    this.bucket = new TokenBucket({ capacity: config.rpc.rateLimitCapacity, refillPerSecond: config.rpc.requestsPerSecond, clock, waitImpl });
    this.health = {
      expectedWallets: this.enabledWallets().length, activeSubscriptions: 0, lastNotificationAt: null,
      reconnectCount: 0, backfilledSignatures: 0, duplicateSignaturesIgnored: 0,
      failedTransactionFetches: 0, decodeFailures: 0, prefilteredNonSwap: 0, droppedBackfill: 0, droppedLive: 0, rateLimited: 0, detectionLatenciesMs: [],
      processed: 0, confirmed: 0, failed: 0, disappeared: 0, quarantineDrops: 0, commitment: 'processed'
    };
  }

  enabledWallets() { return this.config.wallets.filter((wallet) => wallet.enabled); }
  _status(extra = {}) { this.onStatus({ ...extra, observationHealth: this.snapshotHealth() }); }
  snapshotHealth() {
    return {
      expectedWallets: this.health.expectedWallets, activeSubscriptions: this.subscriptionWallets.size,
      lastNotificationAgeMs: this.health.lastNotificationAt ? Math.max(0, this.clock() - this.health.lastNotificationAt) : null,
      reconnectCount: this.health.reconnectCount, backfilledSignatures: this.health.backfilledSignatures,
      duplicateSignaturesIgnored: this.health.duplicateSignaturesIgnored,
      failedTransactionFetches: this.health.failedTransactionFetches, decodeFailures: this.health.decodeFailures,
      prefilteredNonSwap: this.health.prefilteredNonSwap, droppedBackfill: this.health.droppedBackfill, droppedLive: this.health.droppedLive,
      rpcRateLimited: this.health.rateLimited, rpcBackoffMs: Math.max(0, this.rpcBackoffUntil - this.clock()),
      queueDepth: this.queue.length, activeFetches: this.activeFetches, maxQueueSize: this.config.rpc.maxQueueSize,
      medianDetectionLatencyMs: percentile(this.health.detectionLatenciesMs, 0.5),
      p95DetectionLatencyMs: percentile(this.health.detectionLatenciesMs, 0.95),
      processedSignals: this.health.processed, confirmedSignals: this.health.confirmed,
      failedSignals: this.health.failed, disappearedSignals: this.health.disappeared,
      quarantinedWallets: [...this.walletQuarantineUntil].filter(([, until]) => until > this.clock()).map(([wallet, until]) => ({ wallet, remainingMs: until - this.clock() })),
      quarantineDrops: this.health.quarantineDrops,
      commitment: 'processed', rateLimit: this.bucket.status()
    };
  }

  start() {
    if (!this.enabledWallets().length) { this._status({ rpc: 'idle-no-wallets' }); return; }
    if (!this.WebSocketImpl) { this._status({ rpc: 'error', rpcError: 'This Node version has no WebSocket implementation.' }); return; }
    this.stopped = false; this._connect();
  }

  stop() {
    this.stopped = true; clearTimeout(this.reconnectTimer);
    for (const timer of this.confirmationTimers) clearTimeout(timer);
    this.confirmationTimers.clear(); clearTimeout(this.cursorPersistTimer); this.cursorPersistTimer = null;
    this.socket?.close(); this.socket = null; this._persistCursors(true);
  }

  _persistCursors(immediate = false) {
    if (!this.cursorStore?.saveWalletCursors) return;
    if (!immediate) {
      if (this.cursorPersistTimer) return;
      this.cursorPersistTimer = setTimeout(() => { this.cursorPersistTimer = null; this._persistCursors(true); }, 1000);
      this.cursorPersistTimer.unref?.();
      return;
    }
    this.cursorStore.saveWalletCursors(Object.fromEntries([...this.latestSignatureByWallet].map(([wallet, signature]) => [wallet, { signature, slot: this.cursorSlots.get(wallet) || 0, updatedAt: this.clock() }])));
  }

  _connect() {
    if (this.stopped) return;
    this._status({ rpc: 'connecting', rpcError: null });
    try { this.socket = new this.WebSocketImpl(this.config.rpc.wsUrl); }
    catch (error) { this._reconnect(error); return; }
    this.socket.addEventListener('open', () => this._subscribe());
    this.socket.addEventListener('message', (event) => this._onMessage(event.data));
    this.socket.addEventListener('error', () => this._status({ rpc: 'error', rpcError: 'WebSocket error' }));
    this.socket.addEventListener('close', () => this._reconnect(new Error('WebSocket closed')));
  }

  _subscribe() {
    this.pendingSubscriptions.clear(); this.subscriptionWallets.clear();
    for (const wallet of this.enabledWallets()) {
      const id = this.requestId++;
      this.pendingSubscriptions.set(id, wallet);
      this.socket.send(JSON.stringify({
        jsonrpc: '2.0', id, method: 'logsSubscribe',
        params: [{ mentions: [wallet.address] }, { commitment: this.config.rpc.processedCommitment }]
      }));
      void this._baselineOrCatchup(wallet);
    }
    this.reconnectAttempt = 0;
    this._status({ rpc: 'connected', rpcWallets: this.enabledWallets().length, rpcError: null });
  }

  _onMessage(raw) {
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); }
    catch { this.health.decodeFailures += 1; this._status({ rpc: 'degraded', rpcError: 'Malformed WebSocket JSON' }); return; }
    if (message.id && this.pendingSubscriptions.has(message.id) && Number.isInteger(message.result)) {
      const wallet = this.pendingSubscriptions.get(message.id); this.pendingSubscriptions.delete(message.id);
      this.subscriptionWallets.set(message.result, wallet); this._status({ rpc: 'connected', rpcError: null }); return;
    }
    if (message.method !== 'logsNotification') return;
    const wallet = this.subscriptionWallets.get(message.params?.subscription);
    const value = message.params?.result?.value;
    const slot = Number(message.params?.result?.context?.slot || 0);
    if (!wallet || !value?.signature) return;
    const notificationAt = this.clock();
    this.health.lastNotificationAt = notificationAt; this.health.processed += 1;
    const perWalletId = `${value.signature}:${wallet.address}`;
    if (this.seenNotifications.has(perWalletId)) { this.health.duplicateSignaturesIgnored += 1; this._status({ rpc: 'connected' }); return; }
    this.seenNotifications.add(perWalletId);
    this.onEvidence({ type: 'RPC_NOTIFICATION', wallet: wallet.address, signature: value.signature, slot, err: value.err || null, logs: value.logs || [], commitment: 'processed', notificationAt });
    if (value.err) {
      this.health.failed += 1;
      this.onEvidence({ type: 'PROCESSED_FAILED', wallet: wallet.address, signature: value.signature, slot, commitment: 'processed', notificationAt, error: value.err });
      this._status({ rpc: 'connected' }); return;
    }
    if (this.config.rpc.prefilterSwapLogs && Array.isArray(value.logs) && value.logs.length && !looksLikeSwapLogs(value.logs)) {
      this.health.prefilteredNonSwap += 1;
      this.latestSignatureByWallet.set(wallet.address, value.signature); this.cursorSlots.set(wallet.address, slot); this._persistCursors();
      this._status({ rpc: 'connected', rpcError: null }); return;
    }
    if (this.seenGlobalSignatures.has(value.signature)) this.health.duplicateSignaturesIgnored += 1;
    else this.seenGlobalSignatures.add(value.signature);
    this._trimDedupe();
    this.latestSignatureByWallet.set(wallet.address, value.signature); this.cursorSlots.set(wallet.address, slot); this._persistCursors();
    if (this._isWalletQuarantined(wallet.address)) {
      this.health.quarantineDrops += 1;
      this._status({ rpc: 'degraded', rpcError: 'A noisy wallet source is temporarily quarantined.' });
      return;
    }
    void this._enqueue(() => this._processSignature(value.signature, wallet, { notificationAt, slot, commitment: 'processed', backfilled: false }), { priority: 'live' });
  }

  _trimDedupe() {
    if (this.seenNotifications.size > 10000) this.seenNotifications = new Set([...this.seenNotifications].slice(-5000));
    if (this.seenGlobalSignatures.size > 10000) this.seenGlobalSignatures = new Set([...this.seenGlobalSignatures].slice(-5000));
  }

  _isWalletQuarantined(address) {
    const until = Number(this.walletQuarantineUntil.get(address) || 0);
    if (until > this.clock()) return true;
    if (until) this.walletQuarantineUntil.delete(address);
    return false;
  }

  _recordWalletOutcome(wallet, successful, reason = '') {
    const address = wallet.address || wallet;
    const outcomes = this.walletOutcomes.get(address) || [];
    outcomes.push(Boolean(successful));
    if (outcomes.length > 20) outcomes.splice(0, outcomes.length - 20);
    this.walletOutcomes.set(address, outcomes);
    const failures = outcomes.filter((value) => !value).length;
    const ratio = outcomes.length ? failures / outcomes.length : 0;
    if (outcomes.length >= this.config.rpc.quarantineMinimumSamples && ratio >= this.config.rpc.quarantineFailureRatio && !this._isWalletQuarantined(address)) {
      const until = this.clock() + this.config.rpc.quarantineMs;
      this.walletQuarantineUntil.set(address, until);
      this.onEvidence({ type: 'WALLET_SOURCE_QUARANTINED', wallet: address, samples: outcomes.length, failures, failureRatio: ratio, until, reason });
      this._status({ rpc: 'degraded', rpcError: 'A noisy wallet source is temporarily quarantined.' });
    }
  }

  _enqueue(task, { priority = 'live' } = {}) {
    if (this.queue.length >= this.config.rpc.maxQueueSize) {
      const backfillIndex = this.queue.findIndex((item) => item.priority === 'backfill');
      if (priority === 'backfill' || backfillIndex < 0) {
        this.health.droppedBackfill += Number(priority === 'backfill');
        this.health.droppedLive += Number(priority === 'live');
        this._status({ rpc: 'degraded', rpcError: 'RPC work queue is full; low-priority catch-up was bounded.' });
        return Promise.resolve({ status: 'dropped', reason: 'queue-full' });
      }
      const [dropped] = this.queue.splice(backfillIndex, 1);
      this.health.droppedBackfill += 1; dropped.resolve({ status: 'dropped', reason: 'preempted-by-live' });
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, priority };
      if (priority === 'live') {
        const firstBackfill = this.queue.findIndex((queued) => queued.priority === 'backfill');
        if (firstBackfill >= 0) this.queue.splice(firstBackfill, 0, item); else this.queue.push(item);
      } else this.queue.push(item);
      this._drain();
    });
  }

  _drain() {
    while (this.activeFetches < this.config.rpc.fetchConcurrency && this.queue.length) {
      const item = this.queue.shift(); this.activeFetches += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.activeFetches -= 1; this._drain(); });
    }
  }

  async _rpc(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt < this.config.rpc.maxAttempts; attempt += 1) {
      const backoffRemaining = Math.max(0, this.rpcBackoffUntil - this.clock());
      if (backoffRemaining > 0) await this.wait(backoffRemaining);
      await this.bucket.take();
      try {
        const response = await this.fetch(this.config.rpc.httpUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.requestId++, method, params })
        });
        if (response.status === 429) {
          this.health.rateLimited += 1; this.consecutiveRateLimits += 1;
          const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
          const exponential = Math.min(this.config.rpc.backoffMaxMs, 500 * 2 ** Math.min(5, this.consecutiveRateLimits - 1));
          const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(this.config.rpc.backoffMaxMs, retryAfterSeconds * 1000)
            : Math.round(exponential * (0.85 + this.random() * 0.3));
          this.rpcBackoffUntil = Math.max(this.rpcBackoffUntil, this.clock() + delay);
          lastError = new Error(`RPC HTTP 429; retrying after ${delay} ms`);
          this._status({ rpc: 'backing-off', rpcError: lastError.message });
          continue;
        }
        if (!response.ok) {
          lastError = new Error(`RPC HTTP ${response.status}`);
          if (Number(response.status) >= 500 && attempt + 1 < this.config.rpc.maxAttempts) { await this.wait(Math.min(2000, 250 * 2 ** attempt)); continue; }
          throw lastError;
        }
        const payload = await response.json();
        if (payload.error) throw new Error(`RPC ${payload.error.code || ''}: ${payload.error.message || 'error'}`);
        this.consecutiveRateLimits = 0; this.rpcBackoffUntil = 0;
        return payload.result;
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= this.config.rpc.maxAttempts || !/fetch|network|socket|ECONN|timeout/i.test(String(error.message || error))) throw error;
        await this.wait(Math.min(2000, 250 * 2 ** attempt));
      }
    }
    throw lastError || new Error('RPC request failed after retries.');
  }

  async _baselineOrCatchup(wallet) {
    try {
      const previous = this.latestSignatureByWallet.get(wallet.address);
      const signatureOptions = { limit: this.config.rpc.catchupLimit, commitment: this.config.rpc.confirmationCommitment };
      if (previous) signatureOptions.until = previous;
      const raw = await this._enqueue(() => this._rpc('getSignaturesForAddress', [wallet.address, signatureOptions]), { priority: 'backfill' });
      const signatures = (Array.isArray(raw) ? raw : []).filter((item) => item?.signature);
      if (!signatures.length) return;
      if (!previous) {
        this.latestSignatureByWallet.set(wallet.address, signatures[0].signature); this.cursorSlots.set(wallet.address, Number(signatures[0].slot || 0)); this._persistCursors(); return;
      }
      const missed = [];
      for (const item of signatures) { if (item.signature === previous) break; missed.push(item); }
      this.latestSignatureByWallet.set(wallet.address, signatures[0].signature); this.cursorSlots.set(wallet.address, Number(signatures[0].slot || 0)); this._persistCursors();
      for (const item of missed.reverse()) {
        const id = `${item.signature}:${wallet.address}`;
        if (this.seenNotifications.has(id)) { this.health.duplicateSignaturesIgnored += 1; continue; }
        this.seenNotifications.add(id); this.seenGlobalSignatures.add(item.signature);
        this.health.backfilledSignatures += 1;
        this.onEvidence({ type: 'MISSED_BACKFILLED', wallet: wallet.address, signature: item.signature, slot: Number(item.slot || 0), confirmationStatus: item.confirmationStatus || '', notificationAt: this.clock() });
        await this._enqueue(() => this._processSignature(item.signature, wallet, { notificationAt: this.clock(), slot: Number(item.slot || 0), commitment: item.confirmationStatus || 'confirmed', backfilled: true }), { priority: 'backfill' });
      }
      if (missed.length) this._status({ rpc: 'connected', rpcCatchupCount: missed.length });
    } catch (error) { this._status({ rpc: 'degraded', rpcError: `Catch-up failed: ${error.message}` }); }
  }

  async _transaction(signature) {
    if (this.transactionPromises.has(signature)) return this.transactionPromises.get(signature);
    const request = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await this._rpc('getTransaction', [signature, { commitment: this.config.rpc.confirmationCommitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (result) return result;
        if (attempt < 2) await this.wait(350 * (attempt + 1));
      }
      return null;
    })().finally(() => { const timer = setTimeout(() => this.transactionPromises.delete(signature), 10_000); timer.unref?.(); });
    this.transactionPromises.set(signature, request); return request;
  }

  async _processSignature(signature, wallet, timing = {}) {
    if (this._isWalletQuarantined(wallet.address)) { this.health.quarantineDrops += 1; return; }
    if (!timing.backfilled && Number.isFinite(timing.notificationAt) && this.clock() - timing.notificationAt > 10_000) {
      this.health.droppedLive += 1;
      this.onEvidence({ type: 'LIVE_SIGNAL_EXPIRED_BEFORE_FETCH', wallet: wallet.address, signature, ...timing, at: this.clock() });
      return;
    }
    const fetchStartedAt = this.clock();
    try {
      const transaction = await this._transaction(signature);
      const transactionFetchedAt = this.clock();
      if (!transaction) {
        this.health.failedTransactionFetches += 1;
        this._recordWalletOutcome(wallet, false, 'TRANSACTION_FETCH_FAILED');
        this.onEvidence({ type: 'TRANSACTION_FETCH_FAILED', wallet: wallet.address, signature, ...timing, fetchStartedAt, transactionFetchedAt });
        this._status({ rpc: 'degraded', rpcError: 'Transaction unavailable after retries.' }); return;
      }
      let signals;
      try { signals = parseWalletSwaps(transaction, wallet.address, { signature, walletLabel: wallet.label, slot: timing.slot, commitment: timing.commitment }); }
      catch (error) {
        this.health.decodeFailures += 1;
        this._recordWalletOutcome(wallet, false, 'DECODE_FAILED');
        this.onEvidence({ type: 'DECODE_FAILED', wallet: wallet.address, signature, ...timing, fetchStartedAt, transactionFetchedAt, classificationAt: this.clock(), error: error.message });
        this._status({ rpc: 'degraded', rpcError: error.message }); return;
      }
      const classificationAt = this.clock();
      const detectionLatencyMs = Math.max(0, classificationAt - Number(timing.notificationAt || classificationAt));
      if (!signals.length && hasSwapInstruction(transaction)) {
        this.health.decodeFailures += 1;
        this._recordWalletOutcome(wallet, false, 'UNCLASSIFIABLE_SWAP');
        this.onEvidence({ type: 'DECODE_FAILED', wallet: wallet.address, signature, ...timing, fetchStartedAt, transactionFetchedAt, classificationAt, detectionLatencyMs, error: 'Swap-like transaction produced no classifiable wallet balance delta.' });
      }
      else this._recordWalletOutcome(wallet, true);
      for (const signal of signals) await this.onSignal({ ...signal, slot: timing.slot || null, commitment: timing.commitment || 'processed', notificationAt: timing.notificationAt, transactionFetchedAt, classificationAt, detectionLatencyMs, backfilled: Boolean(timing.backfilled) });
      if (signals.length) this.health.detectionLatenciesMs.push(detectionLatencyMs);
      this.health.detectionLatenciesMs = this.health.detectionLatenciesMs.slice(-2000);
      this._status({ rpc: 'connected', lastRpcEventAt: classificationAt, rpcError: null });
      if (signals.length && !timing.backfilled) void this._scheduleConfirmation(signature, wallet, timing.notificationAt || classificationAt);
    } catch (error) {
      this.health.failedTransactionFetches += 1;
      this._recordWalletOutcome(wallet, false, 'TRANSACTION_FETCH_FAILED');
      this.onEvidence({ type: 'TRANSACTION_FETCH_FAILED', wallet: wallet.address, signature, ...timing, fetchStartedAt, transactionFetchedAt: this.clock(), error: error.message });
      this._status({ rpc: 'degraded', rpcError: error.message });
    }
  }

  async _confirmation(signature, wallet, firstObservedAt) {
    try {
      const result = await this._enqueue(() => this._rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]), { priority: 'backfill' });
      const [status] = (Array.isArray(result) ? result : result?.value) || [];
      if (status?.err) { this.health.failed += 1; this.onEvidence({ type: 'PROCESSED_LATER_FAILED', wallet: wallet.address, signature, confirmationStatus: status.confirmationStatus || '', error: status.err, at: this.clock() }); return 'failed'; }
      if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) { this.health.confirmed += 1; this.onEvidence({ type: 'PROCESSED_LATER_CONFIRMED', wallet: wallet.address, signature, confirmationStatus: status.confirmationStatus, at: this.clock() }); return 'confirmed'; }
      if (this.clock() - firstObservedAt >= this.config.rpc.confirmationTimeoutMs) { this.health.disappeared += 1; this.onEvidence({ type: 'PROCESSED_DISAPPEARED', wallet: wallet.address, signature, at: this.clock() }); return 'disappeared'; }
      return 'pending';
    } catch (error) { this._status({ rpc: 'degraded', rpcError: `Confirmation check failed: ${error.message}` }); return 'pending'; }
  }

  async _scheduleConfirmation(signature, wallet, firstObservedAt) {
    const status = await this._confirmation(signature, wallet, firstObservedAt);
    if (status !== 'pending' || this.stopped) return;
    const timer = setTimeout(() => { this.confirmationTimers.delete(timer); void this._scheduleConfirmation(signature, wallet, firstObservedAt); }, this.config.rpc.confirmationPollMs);
    timer.unref?.(); this.confirmationTimers.add(timer);
  }

  _reconnect(error) {
    if (this.stopped) return;
    this.socket = null; this.pendingSubscriptions.clear(); this.subscriptionWallets.clear();
    this.reconnectAttempt += 1; this.health.reconnectCount += 1;
    const base = Math.min(30_000, 500 * 2 ** Math.min(6, this.reconnectAttempt));
    const delay = Math.round(base * (0.75 + this.random() * 0.5));
    this.onEvidence({ type: 'RPC_DATA_GAP', at: this.clock(), reconnectAttempt: this.reconnectAttempt, reason: error.message });
    this._status({ rpc: 'reconnecting', rpcError: error.message, rpcReconnectMs: delay });
    clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => this._connect(), delay); this.reconnectTimer.unref?.();
  }
}

module.exports = { SolanaWalletMonitor, looksLikeSwapLogs };
