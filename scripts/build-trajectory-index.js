'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE = 'C:\\Users\\sheha\\afx\\data\\dune_cache';
const DEFAULT_MANIFEST = 'C:\\Users\\sheha\\afx\\data\\gmgn_historical\\dune_pilot_manifest.jsonl';
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD1Jp9VLBwmh2Yk4jWwJxdu'
]);

function round(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mintAndPrice(row) {
  const bought = String(row.token_bought_mint_address || '');
  const sold = String(row.token_sold_mint_address || '');
  const usd = Number(row.amount_usd);
  if (!(usd > 0)) return null;
  if (!QUOTES.has(bought) && QUOTES.has(sold)) return { mint: bought, price: usd / Number(row.token_bought_amount) };
  if (QUOTES.has(bought) && !QUOTES.has(sold)) return { mint: sold, price: usd / Number(row.token_sold_amount) };
  return null;
}

function tokenTrajectory(rows, metadata = {}) {
  const trades = rows.map((row) => {
    const parsed = mintAndPrice(row);
    return parsed ? { ...parsed, at: Date.parse(row.block_time), volume: Number(row.amount_usd) } : null;
  }).filter((trade) => trade && trade.price > 0 && Number.isFinite(trade.at)).sort((a, b) => a.at - b.at);
  if (!trades.length) return null;
  const mint = trades[0].mint;
  const start = Math.floor(trades[0].at / 60_000) * 60_000;
  const buckets = Array.from({ length: 61 }, (_, minute) => ({ minute, prices: [], volume: 0 }));
  for (const trade of trades) {
    if (trade.mint !== mint) continue;
    const minute = Math.floor((trade.at - start) / 60_000);
    if (minute < 0 || minute >= buckets.length) continue;
    buckets[minute].prices.push(trade.price);
    buckets[minute].volume += trade.volume;
  }
  let lastPrice = buckets.find((bucket) => bucket.prices.length)?.prices[0];
  const price = [];
  const volume = [];
  for (const bucket of buckets) {
    if (bucket.prices.length) lastPrice = bucket.prices.at(-1);
    price.push(lastPrice);
    volume.push(bucket.volume);
  }
  const basePrice = price[0];
  const nonzeroVolumes = volume.filter((value) => value > 0).sort((a, b) => a - b);
  const volumeScale = nonzeroVolumes[Math.floor(nonzeroVolumes.length / 2)] || 1;
  const normalizedPricePath = price.map((value) => round(value / basePrice, 6));
  const normalizedVolumePath = volume.map((value) => round(value / volumeScale, 6));
  let peak = normalizedPricePath[0];
  let maximumDrawdown = 0;
  for (const value of normalizedPricePath) {
    peak = Math.max(peak, value);
    maximumDrawdown = Math.min(maximumDrawdown, value / peak - 1);
  }
  const returns = {};
  for (const minute of [5, 15, 30, 60]) returns[`${minute}m`] = round((normalizedPricePath[minute] - 1) * 100, 4);
  return {
    mint,
    symbol: metadata.symbol || '',
    startAt: start,
    normalizedPricePath,
    normalizedVolumePath,
    maximumFavourableExcursionPct: round((Math.max(...normalizedPricePath) - 1) * 100, 4),
    maximumDrawdownPct: round(maximumDrawdown * 100, 4),
    returns
  };
}

function buildTrajectoryIndex({ cacheDirectory, manifestPath, outputPath }) {
  const metadata = new Map();
  if (fs.existsSync(manifestPath)) {
    for (const line of fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line);
      metadata.set(entry.mint, entry);
    }
  }
  const tokens = [];
  const files = fs.readdirSync(cacheDirectory).filter((name) => /^trades_[a-f0-9]+\.json$/.test(name)).sort();
  for (const file of files) {
    const rows = JSON.parse(fs.readFileSync(path.join(cacheDirectory, file), 'utf8'));
    const first = rows.map(mintAndPrice).find(Boolean);
    const trajectory = tokenTrajectory(rows, metadata.get(first?.mint) || {});
    if (trajectory) tokens.push(trajectory);
  }
  tokens.sort((a, b) => a.mint.localeCompare(b.mint));
  const index = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: { kind: 'cached-migrated-token-trades', files: files.length, networkQueries: 0 },
    resolution: '1m',
    horizonMinutes: 60,
    tokenCount: tokens.length,
    tokens
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

if (require.main === module) {
  const result = buildTrajectoryIndex({
    cacheDirectory: process.env.FLOWDECK_DUNE_CACHE || DEFAULT_CACHE,
    manifestPath: process.env.FLOWDECK_HISTORY_MANIFEST || DEFAULT_MANIFEST,
    outputPath: path.join(PROJECT_ROOT, 'data', 'trajectory.index.json')
  });
  process.stdout.write(`Built ${result.tokenCount}-token compact 1-minute trajectory index (${result.source.networkQueries} network queries).\n`);
}

module.exports = { buildTrajectoryIndex, mintAndPrice, tokenTrajectory };
