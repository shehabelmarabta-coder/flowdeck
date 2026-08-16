'use strict';

class DexScreenerPriceProvider {
  constructor({ config, engine, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.engine = engine;
    this.fetch = fetchImpl;
    this.timer = null;
    this.lastFetched = new Map();
    this.cursor = 0;
    this.busy = false;
  }

  start() {
    if (!this.config.priceFallback.enabled) {
      this.engine.setServiceStatus({ priceFallback: 'disabled' });
      return;
    }
    const interval = Math.max(250, Math.ceil(1000 / this.config.priceFallback.maxRequestsPerSecond));
    this.engine.setServiceStatus({ priceFallback: 'idle' });
    this.timer = setInterval(() => void this._tick(), interval);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (this.busy) return;
    const now = Date.now();
    const mints = this.engine.getActiveMints().filter((mint) => {
      return now - (this.lastFetched.get(mint) || 0) >= this.config.priceFallback.pollMs;
    });
    if (!mints.length) {
      this.engine.setServiceStatus({ priceFallback: 'idle' });
      return;
    }
    const mint = mints[this.cursor % mints.length];
    this.cursor += 1;
    this.lastFetched.set(mint, now);
    this.busy = true;
    try {
      const response = await this.fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`DEX Screener HTTP ${response.status}`);
      const pairs = await response.json();
      const candidates = Array.isArray(pairs)
        ? pairs.filter((pair) => Number(pair?.priceUsd) > 0)
        : [];
      candidates.sort((a, b) => {
        const baseBias = Number(b?.baseToken?.address === mint) - Number(a?.baseToken?.address === mint);
        return baseBias || Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0);
      });
      const pair = candidates[0];
      if (pair) {
        const wrappedSol = 'So11111111111111111111111111111111111111112';
        this.engine.setMarket({
          mint,
          symbol: pair.baseToken?.address === mint ? pair.baseToken?.symbol : pair.quoteToken?.symbol,
          priceUsd: Number(pair.priceUsd),
          priceSol: pair.baseToken?.address === mint && pair.quoteToken?.address === wrappedSol
            ? Number(pair.priceNative) || null
            : null,
          marketCapUsd: Number(pair.marketCap || pair.fdv) || null,
          liquidityUsd: Number(pair?.liquidity?.usd) || null,
          migrated: true,
          routeable: true,
          sellQuoteAvailable: true,
          source: 'dexscreener',
          observedAt: Date.now()
        });
        this.engine.setServiceStatus({ priceFallback: 'connected', lastPriceFallbackAt: Date.now(), priceFallbackError: null });
      } else {
        this.engine.setServiceStatus({ priceFallback: 'no-pair', priceFallbackError: null });
      }
    } catch (error) {
      this.engine.setServiceStatus({ priceFallback: 'degraded', priceFallbackError: error.message });
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { DexScreenerPriceProvider };
