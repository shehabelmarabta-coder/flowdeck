(function installFlowDeckPageBridge() {
  'use strict';

  if (window.__flowDeckPageBridgeInstalled) return;
  window.__flowDeckPageBridgeInstalled = true;
  const shared = window.FlowDeckShared;
  const SOURCE = 'flowdeck-page-v1';
  const CONTENT_SOURCE = 'flowdeck-content-v1';
  const marketDedupe = new Map();
  const tradeDedupe = new Set();
  // Volume/fees/age/social land on different response payloads than price/marketCap
  // (e.g. GMGN's mutil_window_token_info vs live/token_preview). Cache the latest real
  // values per mint so whichever payload triggers marketEmit carries the full picture.
  const marketEnrichment = new Map();
  // Followed/tracked wallets from the logged-in account's own GMGN watchlist (the /follow page's
  // follow_wallet_trade_list network response), reusing the same wallet-address key names already
  // proven against real GMGN trade payloads below - no new extraction logic, just a new source URL.
  const followedWallets = new Set();
  let generation = 1;

  function emit(type, payload) {
    window.postMessage({
      source: SOURCE,
      type,
      payload,
      generation,
      pageUrl: location.href,
      emittedAt: Date.now()
    }, location.origin);
  }

  function safeParse(input) {
    if (input == null) return null;
    if (typeof input === 'object' && !(input instanceof Blob) && !(input instanceof ArrayBuffer)) return input;
    const text = String(input);
    if (text.length > 5_000_000) return null;
    try {
      return JSON.parse(text);
    } catch {
      const first = Math.min(...['{', '['].map((character) => text.indexOf(character)).filter((index) => index >= 0));
      if (!Number.isFinite(first)) return null;
      try {
        return JSON.parse(text.slice(first));
      } catch {
        return null;
      }
    }
  }

  function marketEmit(candidate) {
    if (!candidate.mint || (!(candidate.priceUsd > 0) && !(candidate.marketCapUsd > 0))) return;
    const previous = marketDedupe.get(candidate.mint);
    const now = Date.now();
    if (previous && previous.priceUsd === candidate.priceUsd && previous.marketCapUsd === candidate.marketCapUsd && now - previous.at < 500) return;
    marketDedupe.set(candidate.mint, { priceUsd: candidate.priceUsd, marketCapUsd: candidate.marketCapUsd, at: now });
    emit('MARKET', candidate);
  }

  function tradeEmit(candidate) {
    const id = candidate.signature || `${candidate.wallet}:${candidate.mint}:${candidate.side}:${candidate.observedAt}`;
    if (tradeDedupe.has(id)) return;
    tradeDedupe.add(id);
    if (tradeDedupe.size > 3000) {
      const keep = [...tradeDedupe].slice(-1500);
      tradeDedupe.clear();
      keep.forEach((value) => tradeDedupe.add(value));
    }
    emit('TRADE', { ...candidate, id });
  }

  function inspectPayload(payload, sourceUrl = '') {
    if (!payload || typeof payload !== 'object') return;
    const pageMint = shared.extractMintFromUrl(location.href);
    const queue = [{ value: payload, mint: pageMint, supply: null }];
    let inspected = 0;
    while (queue.length && inspected < 6000) {
      const item = queue.shift();
      const value = item.value;
      inspected += 1;
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        for (const child of value.slice(0, 1000)) queue.push({ value: child, mint: item.mint, supply: item.supply });
        continue;
      }

      const ownMint = shared.pickAddress(value, [
        'token_address', 'tokenAddress', 'mint', 'base_address', 'baseAddress',
        'address', 'contract_address', 'contractAddress'
      ]);
      const mint = ownMint || item.mint;
      const supply = shared.pickNumber(value, ['total_supply', 'totalSupply', 'supply']) || item.supply;
      let priceUsd = shared.pickNumber(value, [
        'price_usd', 'priceUsd', 'usd_price', 'usdPrice', 'current_price_usd', 'currentPriceUsd'
      ]);
      const priceSol = shared.pickNumber(value, ['price_sol', 'priceSol', 'native_price', 'nativePrice']);
      const marketCapUsd = shared.pickNumber(value, [
        'market_cap', 'marketCap', 'market_cap_usd', 'marketCapUsd', 'mcap', 'fdv', 'mc'
      ]);
      const liquidityUsd = shared.pickNumber(value, ['liquidity_usd', 'liquidityUsd', 'liquidity', 'pool_liquidity']);
      const bondingPct = shared.pickNumber(value, ['bonding_pct', 'bondingPct', 'bonding_curve_progress', 'bondingCurveProgress', 'progress']);
      const isOnCurve = value.is_on_curve ?? value.isOnCurve;
      const launchpadStatus = shared.pickNumber(value, ['launchpad_status', 'launchpadStatus']);

      // Real GMGN fields confirmed via live network inspection: total_fee (SOL, matches the
      // "Total Fees" figure shown on-page), creation_timestamp/migrated_timestamp (unix seconds,
      // matches "Token created"/pool-migration times shown on-page), volume_1h/5m/24h (USD,
      // matches the "24h Vol" figure), and twitter/website/telegram link presence for social.
      const volumeUsd = shared.pickNumber(value, [
        'volume_usd', 'volumeUsd', 'volume_24h', 'volume24h', 'volume_1h', 'volume_5m', 'volume_1m', 'volume'
      ]);
      const feesSol = shared.pickNumber(value, ['total_fee', 'totalFee', 'fees_sol', 'feesSol']);
      const creationTimestamp = shared.pickNumber(value, ['creation_timestamp', 'creationTimestamp', 'open_timestamp', 'openTimestamp']);
      const migratedTimestamp = shared.pickNumber(value, ['migrated_timestamp', 'migratedTimestamp']);
      const hasSocial = Boolean(String(value.twitter || '').trim() || String(value.telegram || '').trim() || String(value.website || '').trim());
      if (mint && (volumeUsd != null || feesSol != null || creationTimestamp != null || hasSocial || migratedTimestamp > 0)) {
        const existing = marketEnrichment.get(mint) || {};
        marketEnrichment.set(mint, {
          ...existing,
          volumeUsd: volumeUsd != null ? volumeUsd : existing.volumeUsd,
          feesSol: feesSol != null ? feesSol : existing.feesSol,
          ageMinutes: creationTimestamp != null ? (Date.now() - creationTimestamp * 1000) / 60_000 : existing.ageMinutes,
          hasSocial: hasSocial || existing.hasSocial || false,
          migrated: migratedTimestamp > 0 ? true : existing.migrated
        });
      }

      if (mint && (priceUsd || marketCapUsd) && (ownMint || !pageMint || mint === pageMint)) {
        const enrichment = marketEnrichment.get(mint) || {};
        const migratedReal = enrichment.migrated === true;
        marketEmit({
          mint,
          symbol: String(value.symbol || value.token_symbol || '').slice(0, 24),
          priceUsd,
          priceSol,
          marketCapUsd,
          supply,
          liquidityUsd,
          bondingPct,
          lifecycleStage: migratedReal || launchpadStatus === 2 || isOnCurve === false ? 'MIGRATED' : bondingPct != null || isOnCurve === true ? 'NEAR_COMPLETION' : 'NEW_CREATION',
          migrated: migratedReal || launchpadStatus === 2 || isOnCurve === false,
          nearGraduation: bondingPct != null || isOnCurve === true,
          volumeUsd: enrichment.volumeUsd ?? null,
          feesSol: enrichment.feesSol ?? null,
          ageMinutes: enrichment.ageMinutes ?? null,
          hasSocial: Boolean(enrichment.hasSocial),
          socialViews: enrichment.socialViews ?? null,
          socialComments: enrichment.socialComments ?? null,
          socialLikes: enrichment.socialLikes ?? null,
          socialReposts: enrichment.socialReposts ?? null,
          socialRising: Boolean(enrichment.socialRising),
          source: 'gmgn-network',
          sourceUrl,
          observedAt: Date.now()
        });
      }

      const sideText = String(value.side || value.action || value.trade_type || value.tradeType || '').toLowerCase();
      const side = sideText.includes('buy') ? 'buy' : sideText.includes('sell') ? 'sell' : '';
      const wallet = shared.pickAddress(value, [
        'wallet_address', 'walletAddress', 'wallet', 'owner', 'maker', 'trader_address',
        'traderAddress', 'user_address', 'userAddress'
      ]);
      if (wallet && /\/follow\//i.test(sourceUrl) && !followedWallets.has(wallet)) {
        followedWallets.add(wallet);
        emit('WALLETS', { wallets: [...followedWallets] });
      }
      const signature = String(value.tx_hash || value.txHash || value.signature || value.transaction_hash || '').trim();
      if (side && mint && wallet) {
        const rawFraction = shared.pickNumber(value, ['fraction', 'sell_fraction', 'sellFraction', 'percent', 'percentage']);
        tradeEmit({
          signature,
          wallet,
          walletLabel: String(value.wallet_name || value.walletName || value.label || '').slice(0, 80),
          mint,
          side,
          fraction: rawFraction == null ? null : rawFraction > 1 ? rawFraction / 100 : rawFraction,
          sourcePriceUsd: priceUsd || null,
          sourcePriceSol: priceSol || null,
          observedAt: shared.pickNumber(value, ['timestamp', 'block_time', 'blockTime']) || Date.now(),
          source: 'gmgn-page'
        });
      }

      for (const child of Object.values(value).slice(0, 200)) {
        if (child && typeof child === 'object') queue.push({ value: child, mint, supply });
      }
    }
  }

  async function inspectMessage(data, sourceUrl) {
    if (data instanceof Blob) {
      try { inspectPayload(safeParse(await data.text()), sourceUrl); } catch { /* ignore malformed frames */ }
      return;
    }
    if (data instanceof ArrayBuffer) {
      try { inspectPayload(safeParse(new TextDecoder().decode(data)), sourceUrl); } catch { /* ignore malformed frames */ }
      return;
    }
    inspectPayload(safeParse(data), sourceUrl);
  }

  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = async function flowDeckFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const requestUrl = String(args[0]?.url || args[0] || '');
        const clone = response.clone();
        queueMicrotask(async () => {
          try { inspectPayload(await clone.json(), requestUrl); } catch { /* non-JSON response */ }
        });
      } catch { /* preserve page behavior */ }
      return response;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function flowDeckOpen(method, url, ...rest) {
    this.__flowDeckUrl = String(url || '');
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function flowDeckSend(...args) {
    this.addEventListener('load', () => {
      try {
        if (typeof this.responseText === 'string') inspectPayload(safeParse(this.responseText), this.__flowDeckUrl);
      } catch { /* cross-origin or binary response */ }
    }, { once: true });
    return nativeSend.apply(this, args);
  };

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    function FlowDeckWebSocket(url, protocols) {
      const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      socket.addEventListener('message', (event) => void inspectMessage(event.data, String(url || '')));
      return socket;
    }
    FlowDeckWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(FlowDeckWebSocket, NativeWebSocket);
    window.WebSocket = FlowDeckWebSocket;
  }

  function chartObject() {
    const direct = [window.tvWidget, window.tradingViewWidget, window.widget, window.chartWidget];
    for (const candidate of direct) {
      try {
        const chart = typeof candidate?.activeChart === 'function' ? candidate.activeChart() : candidate;
        if (typeof chart?.createExecutionShape === 'function') return chart;
      } catch { /* try next candidate */ }
    }
    return null;
  }

  function drawFill(fill) {
    const chart = chartObject();
    if (!chart || !fill?.executionPriceUsd) return;
    try {
      const shape = chart.createExecutionShape();
      shape
        .setTime(Math.floor(fill.at / 1000))
        .setPrice(fill.executionPriceUsd)
        .setDirection(fill.side === 'buy' ? 'buy' : 'sell')
        .setText(fill.side === 'buy' ? 'Flow B' : 'Flow S')
        .setArrowColor(fill.side === 'buy' ? '#22e6ca' : '#ff4f87')
        .setTextColor('#e9f8ff');
    } catch { /* chart API is optional and changes across GMGN builds */ }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== CONTENT_SOURCE) return;
    if (event.data.type === 'DRAW_FILL') drawFill(event.data.payload);
  });

  function navigation() {
    generation += 1;
    emit('NAVIGATE', { mint: shared.extractMintFromUrl(location.href), url: location.href });
  }
  for (const method of ['pushState', 'replaceState']) {
    const native = history[method];
    history[method] = function flowDeckHistory(...args) {
      const result = native.apply(this, args);
      queueMicrotask(navigation);
      return result;
    };
  }
  window.addEventListener('popstate', navigation);

  function scanVisibleTrenchesCards() {
    const links = document.querySelectorAll('a[href*="/token/"],a[href*="/sol/"]');
    for (const link of [...links].slice(0, 250)) {
      const mint = shared.extractMintFromUrl(link.href);
      if (!mint) continue;
      let card = link;
      for (let level = 0; level < 6 && card?.parentElement; level += 1) {
        card = card.parentElement;
        if (card.innerText?.length >= 30 && card.innerText.length <= 2500) break;
      }
      const text = String(card?.innerText || '');
      if (!text) continue;
      const marketCapMatch = text.match(/(?:market\s*cap|mcap|mc)\s*[:\n]?\s*\$?([0-9][0-9,.]*(?:\.[0-9]+)?\s*[kmbt]?)/i);
      const priceMatch = text.match(/(?:price)\s*[:\n]?\s*\$?([0-9][0-9,.]*(?:\.[0-9]+)?(?:e[+-]?\d+)?)/i);
      const marketCapUsd = marketCapMatch ? shared.parseCompactNumber(marketCapMatch[1]) : null;
      const priceUsd = priceMatch ? shared.parseCompactNumber(priceMatch[1]) : null;
      if (!(marketCapUsd > 0) && !(priceUsd > 0)) continue;
      const bondingMatch = text.match(/(?:bonding|progress)\s*[:\n]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
      const bondingPct = bondingMatch ? Number(bondingMatch[1]) : null;
      const migrated = /migrated|completed|graduated/i.test(text);
      marketEmit({
        mint, symbol: String(link.textContent || '').trim().slice(0, 24), priceUsd, marketCapUsd,
        bondingPct, migrated, nearGraduation: !migrated && bondingPct != null,
        lifecycleStage: migrated ? 'MIGRATED' : bondingPct != null ? 'NEAR_COMPLETION' : 'NEW_CREATION',
        source: 'gmgn-trenches-visible', observedAt: Date.now()
      });
    }
  }
  setInterval(scanVisibleTrenchesCards, 1000);
  queueMicrotask(scanVisibleTrenchesCards);

  // X = bonus, never a gate. Only the currently-open token's own detail page is scanned (the
  // "already-interesting" token), reading whatever view/comment/like/repost counts GMGN has
  // already rendered next to its X/twitter link - no new scraper, no external X/Claude API.
  // Missing metrics simply leave these fields undefined, which the engine treats as neutral.
  const socialSamples = new Map();
  function scanSocialPreview() {
    const pageMint = shared.extractMintFromUrl(location.href);
    if (!pageMint) return;
    const link = document.querySelector('a[href*="x.com/"],a[href*="twitter.com/"]');
    if (!link) return;
    let card = link;
    for (let level = 0; level < 4 && card?.parentElement; level += 1) card = card.parentElement;
    const text = String(card?.innerText || link.innerText || '');
    if (!text) return;
    const views = text.match(/([0-9][0-9,.]*\s*[kmbt]?)\s*(?:views?|impressions?)/i);
    const comments = text.match(/([0-9][0-9,.]*\s*[kmbt]?)\s*(?:comments?|repl(?:y|ies))/i);
    const likes = text.match(/([0-9][0-9,.]*\s*[kmbt]?)\s*(?:likes?)/i);
    const reposts = text.match(/([0-9][0-9,.]*\s*[kmbt]?)\s*(?:reposts?|retweets?)/i);
    const socialViews = views ? shared.parseCompactNumber(views[1]) : null;
    const socialComments = comments ? shared.parseCompactNumber(comments[1]) : null;
    const socialLikes = likes ? shared.parseCompactNumber(likes[1]) : null;
    const socialReposts = reposts ? shared.parseCompactNumber(reposts[1]) : null;
    const existing = marketEnrichment.get(pageMint) || {};
    marketEnrichment.set(pageMint, {
      ...existing,
      hasSocial: true,
      socialViews: socialViews ?? existing.socialViews,
      socialComments: socialComments ?? existing.socialComments,
      socialLikes: socialLikes ?? existing.socialLikes,
      socialReposts: socialReposts ?? existing.socialReposts
    });
    const t0 = socialSamples.get(pageMint);
    if (!t0 || Date.now() - t0.at > 5000) {
      socialSamples.set(pageMint, { at: Date.now(), socialViews, socialComments });
    } else {
      const rising = (socialViews > (t0.socialViews || 0)) || (socialComments > (t0.socialComments || 0));
      if (rising) marketEnrichment.set(pageMint, { ...marketEnrichment.get(pageMint), socialRising: true });
    }
  }
  setInterval(scanSocialPreview, 1000);
  queueMicrotask(scanSocialPreview);

  // Passive interception (above) only sees the followed-wallet list if the user happens to be
  // on the /follow (Track) page when it loads. Actively re-requesting the same real endpoint
  // (confirmed live: GET /vas/api/v1/follow/follow_wallet_trade_list) from any GMGN page - using
  // the page's own session cookies, no new service - means the roster stays current regardless
  // of which page is open. A failed/unauthenticated response is caught and simply changes
  // nothing, leaving the generated-wallet fallback in effect.
  async function refreshFollowedWallets() {
    if (!nativeFetch) return;
    try {
      const response = await nativeFetch('/vas/api/v1/follow/follow_wallet_trade_list?chain=sol&network=sol&with_balance=true', { credentials: 'include' });
      inspectPayload(await response.json(), '/vas/api/v1/follow/follow_wallet_trade_list');
    } catch { /* not logged in, or GMGN changed the endpoint - fallback roster stays in effect */ }
  }
  setInterval(refreshFollowedWallets, 60_000);
  queueMicrotask(refreshFollowedWallets);

  emit('READY', { mint: shared.extractMintFromUrl(location.href), url: location.href });
})();
