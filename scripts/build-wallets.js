'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ADDRESS_RE } = require('../src/engine');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE = 'C:\\Users\\sheha\\afx\\data\\dune_cache';
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD1Jp9VLBwmh2Yk4jWwJxdu'
]);
const ACTIVE_CANDIDATE_CAP = 40;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function classify(row) {
  const bought = String(row.token_bought_mint_address || '');
  const sold = String(row.token_sold_mint_address || '');
  if (!QUOTES.has(bought) && QUOTES.has(sold)) return { side: 'buy', mint: bought, tokenAmount: Number(row.token_bought_amount) };
  if (QUOTES.has(bought) && !QUOTES.has(sold)) return { side: 'sell', mint: sold, tokenAmount: Number(row.token_sold_amount) };
  return null;
}

function jaccard(left, right) {
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / Math.max(1, left.size + right.size - overlap);
}

function scoreWallet(address, tokenEvents, tokenStarts) {
  const lifecycles = [];
  let buys = 0;
  let sells = 0;
  let grossBoughtUsd = 0;
  let grossSoldUsd = 0;
  const entryTimes = [];
  const holdingTimes = [];
  const behavior = new Set();

  for (const [mint, events] of tokenEvents) {
    events.sort((a, b) => a.at - b.at || a.tx.localeCompare(b.tx));
    const buyEvents = events.filter((event) => event.side === 'buy');
    const sellEvents = events.filter((event) => event.side === 'sell');
    buys += buyEvents.length;
    sells += sellEvents.length;
    const boughtUsd = buyEvents.reduce((sum, event) => sum + event.usd, 0);
    const soldUsd = sellEvents.reduce((sum, event) => sum + event.usd, 0);
    const boughtTokens = buyEvents.reduce((sum, event) => sum + event.tokenAmount, 0);
    const soldTokens = sellEvents.reduce((sum, event) => sum + event.tokenAmount, 0);
    grossBoughtUsd += boughtUsd;
    grossSoldUsd += soldUsd;
    const firstBuy = buyEvents[0];
    const lastSell = sellEvents.at(-1);
    if (firstBuy) {
      const entryMinutes = Math.max(0, (firstBuy.at - (tokenStarts.get(mint) || firstBuy.at)) / 60_000);
      entryTimes.push(entryMinutes);
      behavior.add(`${mint}:${Math.round(entryMinutes / 2)}`);
    }
    const completionRatio = boughtTokens > 0 ? Math.min(1, soldTokens / boughtTokens) : 0;
    const completed = Boolean(firstBuy && lastSell && lastSell.at >= firstBuy.at && completionRatio >= 0.8);
    const matchedCostUsd = boughtUsd * completionRatio;
    const modeledNetUsd = completed ? soldUsd - matchedCostUsd : 0;
    if (completed) holdingTimes.push((lastSell.at - firstBuy.at) / 60_000);
    lifecycles.push({ mint, completed, modeledNetUsd, matchedCostUsd });
  }

  const completed = lifecycles.filter((cycle) => cycle.completed);
  const wins = completed.filter((cycle) => cycle.modeledNetUsd > 0).length;
  const modeledCostUsd = completed.reduce((sum, cycle) => sum + cycle.matchedCostUsd, 0);
  const modeledNetPerformanceUsd = completed.reduce((sum, cycle) => sum + cycle.modeledNetUsd, 0);
  const shrunkWinRate = (wins + 2) / (completed.length + 4);
  const distinctTokens = tokenEvents.size;
  const trades = buys + sells;
  const tradesPerToken = trades / Math.max(1, distinctTokens);
  const medianEntryTimeMinutes = median(entryTimes);
  const medianHoldingTimeMinutes = median(holdingTimes);
  const returnOnModeledCost = modeledCostUsd > 0 ? modeledNetPerformanceUsd / modeledCostUsd : 0;
  const sampleScore = Math.min(1, completed.length / 8);
  const speedScore = medianEntryTimeMinutes == null ? 0 : Math.exp(-medianEntryTimeMinutes / 30);
  const holdScore = medianHoldingTimeMinutes == null ? 0 : Math.exp(-Math.abs(Math.log((medianHoldingTimeMinutes + 1) / 16)) / 2);
  const churnScore = 1 / (1 + Math.max(0, tradesPerToken - 8) / 12);
  const performanceScore = Math.max(0, Math.min(1, (returnOnModeledCost + 0.25) / 1.25));
  const copyabilityScore = 100 * churnScore * (0.30 * shrunkWinRate + 0.25 * sampleScore + 0.20 * speedScore + 0.10 * holdScore + 0.15 * performanceScore);

  let exclusionReason = null;
  if (!ADDRESS_RE.test(address) || QUOTES.has(address)) exclusionReason = 'invalid-or-system-address';
  else if (completed.length < 2) exclusionReason = 'fewer-than-2-meaningful-completed-lifecycles';
  else if (distinctTokens < 2) exclusionReason = 'insufficient-token-diversity';
  else if (tradesPerToken > 40 || trades > 1500) exclusionReason = 'extreme-churn-unlikely-copyable';
  else if (grossBoughtUsd < 50) exclusionReason = 'insufficient-observed-size';

  return {
    address,
    distinctTokensTraded: distinctTokens,
    completedTokenLifecycles: completed.length,
    modeledNetPerformanceUsd: round(modeledNetPerformanceUsd, 2),
    modeledReturnPct: round(returnOnModeledCost * 100, 2),
    winRatePct: round(completed.length ? wins / completed.length * 100 : 0, 2),
    shrunkWinRatePct: round(shrunkWinRate * 100, 2),
    medianEntryTimeMinutes: round(medianEntryTimeMinutes, 2),
    medianHoldingTimeMinutes: round(medianHoldingTimeMinutes, 2),
    buys,
    sells,
    tradesPerToken: round(tradesPerToken, 2),
    copyabilityScore: round(copyabilityScore, 4),
    correlationPenalty: 1,
    finalWeight: null,
    exclusionReason,
    enabled: !exclusionReason,
    _behavior: behavior
  };
}

function buildWalletRoster({ cacheDirectory, outputPath }) {
  if (!fs.existsSync(cacheDirectory)) throw new Error(`Cached Dune directory not found: ${cacheDirectory}`);
  const files = fs.readdirSync(cacheDirectory).filter((name) => /^trades_[a-f0-9]+\.json$/.test(name)).sort();
  if (!files.length) throw new Error(`No cached Dune trade files found in ${cacheDirectory}`);
  const wallets = new Map();
  const tokenStarts = new Map();
  const seenTransactions = new Set();
  let sourceRows = 0;

  for (const file of files) {
    const rows = JSON.parse(fs.readFileSync(path.join(cacheDirectory, file), 'utf8'));
    if (!Array.isArray(rows)) continue;
    sourceRows += rows.length;
    for (const row of rows) {
      const classified = classify(row);
      const address = String(row.trader_id || '').trim();
      const usd = Number(row.amount_usd);
      const at = Date.parse(row.block_time);
      const tx = String(row.tx_id || '');
      if (!classified || !ADDRESS_RE.test(classified.mint) || !ADDRESS_RE.test(address) || !(usd > 0) || !(classified.tokenAmount > 0) || !Number.isFinite(at)) continue;
      const unique = `${tx}:${address}:${classified.mint}:${classified.side}`;
      if (seenTransactions.has(unique)) continue;
      seenTransactions.add(unique);
      tokenStarts.set(classified.mint, Math.min(tokenStarts.get(classified.mint) || at, at));
      if (!wallets.has(address)) wallets.set(address, new Map());
      const tokens = wallets.get(address);
      if (!tokens.has(classified.mint)) tokens.set(classified.mint, []);
      tokens.get(classified.mint).push({ ...classified, usd, at, tx });
    }
  }

  const evaluated = [...wallets.entries()].map(([address, tokens]) => scoreWallet(address, tokens, tokenStarts));
  const preliminary = evaluated.filter((wallet) => !wallet.exclusionReason)
    .sort((a, b) => b.copyabilityScore - a.copyabilityScore || a.address.localeCompare(b.address));
  const correlationPool = preliminary.slice(0, 300);
  for (let index = 0; index < correlationPool.length; index += 1) {
    let maximum = 0;
    for (let other = 0; other < index; other += 1) maximum = Math.max(maximum, jaccard(correlationPool[index]._behavior, correlationPool[other]._behavior));
    correlationPool[index].correlationPenalty = round(maximum >= 0.7 ? Math.max(0.4, 1 - maximum * 0.6) : 1, 4);
  }
  for (const wallet of evaluated) wallet.rawFinalScore = round(wallet.copyabilityScore * wallet.correlationPenalty, 4);
  const selected = evaluated.filter((wallet) => !wallet.exclusionReason)
    .sort((a, b) => b.rawFinalScore - a.rawFinalScore || a.address.localeCompare(b.address))
    .slice(0, ACTIVE_CANDIDATE_CAP);
  const meanScore = selected.reduce((sum, wallet) => sum + wallet.rawFinalScore, 0) / Math.max(1, selected.length);
  for (const wallet of selected) wallet.finalWeight = Math.max(0.5, Math.min(2, wallet.rawFinalScore / meanScore));
  const clippedMean = selected.reduce((sum, wallet) => sum + wallet.finalWeight, 0) / Math.max(1, selected.length);
  for (const wallet of selected) wallet.finalWeight = round(Math.max(0.5, Math.min(2, wallet.finalWeight / clippedMean)), 6);
  const selectedAddresses = new Set(selected.map((wallet) => wallet.address));
  for (const wallet of evaluated) {
    if (!wallet.exclusionReason && !selectedAddresses.has(wallet.address)) wallet.exclusionReason = `ranked-below-${ACTIVE_CANDIDATE_CAP}-active-candidate-cap`;
    delete wallet._behavior;
  }
  selected.forEach((wallet, index) => { wallet.rank = index + 1; wallet.label = `Dune candidate ${index + 1}`; wallet.exclusionReason = null; });
  evaluated.sort((a, b) => a.address.localeCompare(b.address));

  const output = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    deterministic: true,
    source: { kind: 'cached-dune-token-trades', directory: cacheDirectory, files: files.length, rows: sourceRows, networkQueries: 0 },
    description: 'Dune-derived candidate wallets ranked for copyability; this is not a claim that they are the best wallets.',
    candidateCount: selected.length,
    wallets: selected,
    evaluatedWallets: evaluated
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return output;
}

if (require.main === module) {
  const cacheDirectory = process.env.FLOWDECK_DUNE_CACHE || DEFAULT_CACHE;
  const outputPath = path.join(PROJECT_ROOT, 'data', 'wallets.generated.json');
  const roster = buildWalletRoster({ cacheDirectory, outputPath });
  process.stdout.write(`Generated ${roster.candidateCount} Dune-derived candidate wallets from ${roster.source.files} cached tapes (${roster.source.networkQueries} network queries).\n`);
}

module.exports = { buildWalletRoster, classify, scoreWallet };
