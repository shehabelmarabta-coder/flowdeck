'use strict';

const { applyHaircut, atomic, atomicToDecimalString, SOL_MINT } = require('./atomic');
const { PriorityScheduler, TokenBucket } = require('./provider-scheduler');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const PRICE_QUALITY = Object.freeze({
  REFERENCE_MARK: 'REFERENCE_MARK',
  JUPITER_ROUTE_QUOTE: 'JUPITER_ROUTE_QUOTE',
  JUPITER_BUILDABLE_ORDER: 'JUPITER_BUILDABLE_ORDER',
  LIVE_FILL: 'LIVE_FILL'
});

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function safeAtomic(value, fallback = '0') { try { return atomic(value); } catch { return atomic(fallback); } }

// minimumOutputAtomic/otherAmountThreshold is a protection floor (refuse to fill below this),
// not a price forecast - it carries Jupiter's own slippage buffer on top of real price impact.
// The realistic estimate for both pricing a fill and sizing a dependent quote is the raw quoted
// outAmount minus modelled price impact and a small realistic slippage allowance.
function modelledFillOutput(quote, realisticSlippageBps) {
  const out = safeAtomic(quote?.outAmountAtomic);
  if (out <= 0n) return { atomic: '0', slippageBps: 0 };
  const priceImpactBps = Math.abs(Number(quote?.priceImpactPct ?? 0)) * 10_000;
  const slippageBps = Math.max(0, Math.min(10_000, Math.round(priceImpactBps + Number(realisticSlippageBps || 0))));
  return { atomic: (out * BigInt(10_000 - slippageBps) / 10_000n).toString(), slippageBps };
}

class JupiterOrderClient {
  constructor({
    config, fetchImpl = globalThis.fetch, clock = () => Date.now(), waitImpl,
    apiKey = process.env.JUPITER_API_KEY || '', decimalsResolver = async (mint) => mint === SOL_MINT ? 9 : null,
    onQuote = () => {}
  }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.apiKey = String(apiKey || '');
    this.decimalsResolver = decimalsResolver;
    this.onQuote = onQuote;
    this.wait = waitImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.scheduler = new PriorityScheduler({
      name: 'jupiter', maxConcurrency: config.jupiter.maxConcurrency, maxQueueSize: config.jupiter.maxQueueSize,
      reserveExitFraction: 0.6, rateLimitCapacity: config.jupiter.rateLimitCapacity,
      requestsPerSecond: config.jupiter.requestsPerSecond, clock, waitImpl: this.wait
    });
    this.inflight = new Map();
    this.cache = new Map();
    this.solUsdCache = null;
    this.metrics = { requests: 0, successes: 0, buildable: 0, noRoute: 0, failures: 0, rateLimited: 0, latencies: [], currentRouter: null, lastQuoteAt: null, lastErrorCode: null };
  }

  _cacheKey(inputMint, outputMint, inputAmountAtomic, taker) { return `${inputMint}:${outputMint}:${inputAmountAtomic}:${taker || ''}`; }

  _cacheResult(key, value) {
    const cutoff = this.clock() - this.config.jupiter.cacheMs;
    for (const [cachedKey, cached] of this.cache) if (cached.cachedAt < cutoff) this.cache.delete(cachedKey);
    while (this.cache.size >= this.config.jupiter.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { cachedAt: this.clock(), value });
    return value;
  }

  async order({ inputMint, outputMint, inputAmountAtomic, taker = null, purpose = 'PAPER_QUOTE', fresh = false }) {
    const amount = atomic(inputAmountAtomic);
    if (amount <= 0n) return { ok: false, outcome: 'NO_ROUTE', errorCode: 'INVALID_AMOUNT', errorMessage: 'Atomic input amount must be positive.' };
    const effectiveTaker = taker || null;
    const key = this._cacheKey(inputMint, outputMint, amount, effectiveTaker);
    const cached = this.cache.get(key);
    if (!fresh && cached && this.clock() - cached.cachedAt <= this.config.jupiter.cacheMs) return { ...cached.value, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const priority = /^(?:POSITION|EXIT|RESET|SELL)/.test(String(purpose).toUpperCase()) ? 'exit' : 'entry';
    const promise = this.scheduler.submit(
      () => this._requestOrder({ inputMint, outputMint, inputAmountAtomic: amount.toString(), taker: effectiveTaker, purpose }),
      { priority }
    )
      .then((value) => this._cacheResult(key, value))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async _requestOrder({ inputMint, outputMint, inputAmountAtomic, taker, purpose }) {
    const query = new URLSearchParams({ inputMint, outputMint, amount: inputAmountAtomic });
    if (taker) query.set('taker', taker);
    const base = String(this.config.jupiter.baseUrl || 'https://api.jup.ag/swap/v2').replace(/\/$/, '');
    const url = `${base}/order?${query}`;
    let last = null;
    for (let attempt = 0; attempt < this.config.jupiter.maxAttempts; attempt += 1) {
      const requestedAt = this.clock();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.jupiter.timeoutMs);
      this.metrics.requests += 1;
      let status = 0;
      try {
        const headers = { accept: 'application/json' };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        const response = await this.fetch(url, { method: 'GET', headers, signal: controller.signal, cache: 'no-store' });
        status = response.status;
        const payload = await response.json().catch(() => ({}));
        const receivedAt = this.clock();
        const latencyMs = Math.max(0, receivedAt - requestedAt);
        this.metrics.latencies.push(latencyMs); this.metrics.latencies = this.metrics.latencies.slice(-1000);
        if (status === 429) {
          this.metrics.rateLimited += 1;
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const resetAt = Number(response.headers?.get?.('x-ratelimit-reset')) * 1000;
          const headerDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000
            : Number.isFinite(resetAt) && resetAt > this.clock() ? resetAt - this.clock() : 0;
          const delay = Math.min(this.config.jupiter.backoffMaxMs, Math.max(headerDelay, 500 * 2 ** attempt));
          last = this._errorResult({ purpose, inputMint, outputMint, inputAmountAtomic, requestedAt, receivedAt, latencyMs, status, payload, outcome: 'RATE_LIMITED', errorCode: 'RATE_LIMITED' });
          if (attempt + 1 < this.config.jupiter.maxAttempts) { await this.wait(delay); continue; }
          this.metrics.lastErrorCode = 'RATE_LIMITED'; this.onQuote(last); return last;
        }
        const outAmountAtomic = String(payload.outAmount || payload.outputAmount || '');
        const validOutput = /^\d+$/.test(outAmountAtomic) && BigInt(outAmountAtomic) > 0n;
        if (!response.ok || !validOutput) {
          if (status >= 500 && attempt + 1 < this.config.jupiter.maxAttempts) { await this.wait(Math.min(this.config.jupiter.backoffMaxMs, 250 * 2 ** attempt)); continue; }
          this.metrics.noRoute += 1;
          const result = this._errorResult({ purpose, inputMint, outputMint, inputAmountAtomic, requestedAt, receivedAt, latencyMs, status, payload, outcome: 'NO_ROUTE', errorCode: payload.errorCode ?? (status || 'NO_ROUTE') });
          this.metrics.lastErrorCode = result.errorCode; this.onQuote(result); return result;
        }
        const buildable = Boolean(taker && typeof payload.transaction === 'string' && payload.transaction.length > 0);
        const result = {
          ok: true, outcome: 'ROUTE', purpose, inputMint, outputMint, inputAmountAtomic, outAmountAtomic,
          minimumOutputAtomic: String(payload.otherAmountThreshold || payload.minOutAmount || ''),
          requestId: String(payload.requestId || ''), router: String(payload.router || ''), mode: String(payload.mode || ''),
          priceQuality: buildable ? PRICE_QUALITY.JUPITER_BUILDABLE_ORDER : PRICE_QUALITY.JUPITER_ROUTE_QUOTE,
          transactionPresent: buildable, transaction: buildable ? payload.transaction : null,
          routePlan: Array.isArray(payload.routePlan) ? payload.routePlan : [], priceImpactPct: payload.priceImpactPct ?? payload.priceImpact ?? null,
          slippageBps: payload.slippageBps ?? null, signatureFeeLamports: String(payload.signatureFeeLamports || '0'),
          prioritizationFeeLamports: String(payload.prioritizationFeeLamports || '0'), rentFeeLamports: String(payload.rentFeeLamports || '0'), gasless: Boolean(payload.gasless),
          feeAccountingComplete: payload.signatureFeeLamports != null && payload.prioritizationFeeLamports != null && payload.rentFeeLamports != null,
          feeBps: payload.feeBps ?? '', feeMint: payload.feeMint || payload.platformFee?.feeMint || '',
          platformFeeAmountAtomic: String(payload.platformFee?.amount || ''), platformFeeBps: payload.platformFee?.feeBps ?? '',
          requestedAt, receivedAt, requestTimestampUtc: new Date(requestedAt).toISOString(), responseTimestampUtc: new Date(receivedAt).toISOString(),
          latencyMs, httpStatus: status, errorCode: payload.errorCode ?? '', errorMessage: String(payload.errorMessage || '').slice(0, 300)
        };
        this.metrics.successes += 1; if (buildable) this.metrics.buildable += 1;
        this.metrics.currentRouter = result.router; this.metrics.lastQuoteAt = receivedAt; this.metrics.lastErrorCode = null;
        this.onQuote(result); return result;
      } catch (error) {
        const receivedAt = this.clock();
        const latencyMs = Math.max(0, receivedAt - requestedAt);
        if (attempt + 1 < this.config.jupiter.maxAttempts && /Abort|fetch|network|socket|ECONN|timeout/i.test(`${error.name} ${error.message}`)) {
          await this.wait(Math.min(this.config.jupiter.backoffMaxMs, 250 * 2 ** attempt));
          continue;
        }
        this.metrics.failures += 1; this.metrics.latencies.push(latencyMs); this.metrics.latencies = this.metrics.latencies.slice(-1000);
        const result = this._errorResult({ purpose, inputMint, outputMint, inputAmountAtomic, requestedAt, receivedAt, latencyMs, status, payload: {}, outcome: 'PROVIDER_UNAVAILABLE', errorCode: error.name === 'AbortError' ? 'QUOTE_TIMEOUT' : 'QUOTE_FETCH_FAILED', errorMessage: error.name === 'AbortError' ? 'Jupiter order quote timed out.' : error.message });
        this.metrics.lastErrorCode = result.errorCode; this.onQuote(result); return result;
      } finally { clearTimeout(timeout); }
    }
    return last;
  }

  _errorResult({ purpose, inputMint, outputMint, inputAmountAtomic, requestedAt, receivedAt, latencyMs, status, payload, outcome, errorCode, errorMessage }) {
    return {
      ok: false, outcome, purpose, inputMint, outputMint, inputAmountAtomic,
      requestedAt, receivedAt, requestTimestampUtc: new Date(requestedAt).toISOString(), responseTimestampUtc: new Date(receivedAt).toISOString(),
      latencyMs, httpStatus: status, requestId: payload?.requestId || '', router: payload?.router || '', mode: payload?.mode || '',
      errorCode, errorMessage: String(errorMessage || payload?.errorMessage || `Jupiter order HTTP ${status}`).slice(0, 300)
    };
  }

  async prepareEntry({ outputMint, inputLamports, taker = this.config.jupiter.paperTakerAddress || null, fresh = false }) {
    const entry = await this.order({ inputMint: SOL_MINT, outputMint, inputAmountAtomic: inputLamports, taker, purpose: 'ENTRY', fresh });
    if (!entry.ok) return { ok: false, outcome: entry.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED' : entry.errorCode === 'QUOTE_TIMEOUT' ? 'QUOTE_EXPIRED' : 'NO_ENTRY_ROUTE', entry, reverse: null };
    let tokenDecimals = null;
    try { tokenDecimals = await this.decimalsResolver(outputMint); }
    catch (error) {
      return { ok: false, outcome: 'TOKEN_DECIMALS_UNAVAILABLE', entry, reverse: null, tokenDecimals: null, errorMessage: String(error.message || error).slice(0, 300) };
    }
    if (!Number.isInteger(Number(tokenDecimals)) || Number(tokenDecimals) < 0 || Number(tokenDecimals) > 255) {
      return { ok: false, outcome: 'TOKEN_DECIMALS_UNAVAILABLE', entry, reverse: null, tokenDecimals: null };
    }
    const threshold = /^\d+$/.test(String(entry.minimumOutputAtomic || '')) && atomic(entry.minimumOutputAtomic) > 0n
      ? atomic(entry.minimumOutputAtomic)
      : applyHaircut(entry.outAmountAtomic, this.config.jupiter.paperExecutionHaircutBps);
    const conservativeTokenAtomic = threshold.toString();
    // Reverse leg is sized off the realistic modelled fill, not the conservative/floor entry
    // amount - sizing it off the floor made the immediate round-trip look ~20% worse than real
    // (selling fewer tokens than you would actually receive), which fed a systematically
    // inflated friction estimate into the risk model regardless of the token's real liquidity.
    const modelledTokenAtomic = modelledFillOutput(entry, this.config.paper.realisticSlippageBps).atomic;
    const reverseSizeAtomic = atomic(modelledTokenAtomic) > 0n ? modelledTokenAtomic : conservativeTokenAtomic;
    const reverse = await this.order({ inputMint: outputMint, outputMint: SOL_MINT, inputAmountAtomic: reverseSizeAtomic, taker, purpose: 'IMMEDIATE_REVERSE', fresh });
    if (!reverse.ok) return { ok: false, outcome: reverse.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NO_SELL_ROUTE', entry, reverse, tokenDecimals, conservativeTokenAtomic, modelledTokenAtomic };
    const conservativeReverseLamports = (/^\d+$/.test(String(reverse.minimumOutputAtomic || '')) && atomic(reverse.minimumOutputAtomic) > 0n
      ? atomic(reverse.minimumOutputAtomic)
      : atomic(reverse.outAmountAtomic) * (10_000n - BigInt(Math.trunc(this.config.paper.slippageBps))) / 10_000n).toString();
    const roundTripLossLamports = (atomic(inputLamports) - atomic(reverse.outAmountAtomic)).toString();
    const conservativeRoundTripLossLamports = (atomic(inputLamports) - atomic(conservativeReverseLamports)).toString();
    const roundTripLossBps = Number(atomic(inputLamports) > 0n ? (atomic(roundTripLossLamports) * 10_000n / atomic(inputLamports)) : 0n);
    const conservativeRoundTripLossBps = Number(atomic(inputLamports) > 0n ? (atomic(conservativeRoundTripLossLamports) * 10_000n / atomic(inputLamports)) : 0n);
    return { ok: true, outcome: 'ROUTABLE', entry, reverse, tokenDecimals, conservativeTokenAtomic, modelledTokenAtomic, conservativeReverseLamports, quotedTokenAtomic: entry.outAmountAtomic, roundTripLossLamports, roundTripLossBps, conservativeRoundTripLossLamports, conservativeRoundTripLossBps };
  }

  async quoteReverse({ mint, tokenAmountAtomic, taker = this.config.jupiter.paperTakerAddress || null, purpose = 'POSITION_VALUE', fresh = false }) {
    return this.order({ inputMint: mint, outputMint: SOL_MINT, inputAmountAtomic: tokenAmountAtomic, taker, purpose, fresh });
  }

  async quoteSolUsd({ fresh = false } = {}) {
    if (!fresh && this.solUsdCache && this.clock() - this.solUsdCache.observedAt <= this.config.jupiter.solUsdRefreshMs) return { ...this.solUsdCache, cached: true };
    const quote = await this.order({ inputMint: SOL_MINT, outputMint: USDC_MINT, inputAmountAtomic: '1000000000', purpose: 'SOL_USD', fresh });
    if (!quote.ok) return { ok: false, outcome: quote.outcome, errorCode: quote.errorCode, quote };
    const price = atomicToDecimalString(quote.outAmountAtomic, 6);
    if (!(Number(price) > 0)) return { ok: false, outcome: 'PROVIDER_UNAVAILABLE', errorCode: 'INVALID_SOL_USD_ROUTE', quote };
    this.solUsdCache = { ok: true, price, observedAt: quote.receivedAt, source: 'JUPITER_SOL_USDC_EXACT_ROUTE', quote: { requestId: quote.requestId, router: quote.router, outAmountAtomic: quote.outAmountAtomic } };
    return this.solUsdCache;
  }

  status() {
    return {
      available: Boolean(this.fetch), requests: this.metrics.requests, successes: this.metrics.successes,
      successRatePct: this.metrics.requests ? this.metrics.successes / this.metrics.requests * 100 : 0,
      buildableRatePct: this.metrics.successes ? this.metrics.buildable / this.metrics.successes * 100 : 0,
      noRouteRatePct: this.metrics.requests ? this.metrics.noRoute / this.metrics.requests * 100 : 0,
      failures: this.metrics.failures, rateLimited: this.metrics.rateLimited,
      medianLatencyMs: percentile(this.metrics.latencies, 0.5), p95LatencyMs: percentile(this.metrics.latencies, 0.95),
      currentRouter: this.metrics.currentRouter, lastQuoteAt: this.metrics.lastQuoteAt,
      currentQuoteAgeMs: this.metrics.lastQuoteAt ? Math.max(0, this.clock() - this.metrics.lastQuoteAt) : null,
      lastErrorCode: this.metrics.lastErrorCode, scheduler: this.scheduler.status(), rateLimit: this.scheduler.bucket.status(),
      cacheEntries: this.cache.size, cacheLimit: this.config.jupiter.maxCacheEntries,
      solUsd: this.solUsdCache ? { price: this.solUsdCache.price, ageMs: Math.max(0, this.clock() - this.solUsdCache.observedAt), source: this.solUsdCache.source } : null,
      paperTakerConfigured: Boolean(this.config.jupiter.paperTakerAddress), executionEnabled: false
    };
  }
}

module.exports = { JupiterOrderClient, modelledFillOutput, PRICE_QUALITY, TokenBucket, percentile };
