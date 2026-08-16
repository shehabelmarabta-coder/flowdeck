'use strict';

const fs = require('node:fs');

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeCandles(candles) {
  const usable = candles.filter((candle) => Number(candle?.close ?? candle?.price) > 0).sort((a, b) => Number(a.time || a.at) - Number(b.time || b.at));
  if (!usable.length) return { price: [], volume: [] };
  const base = Number(usable[0].close ?? usable[0].price);
  const volumes = usable.map((candle) => Number(candle.volume || 0)).filter((value) => value > 0).sort((a, b) => a - b);
  const volumeScale = volumes[Math.floor(volumes.length / 2)] || 1;
  return {
    price: usable.map((candle) => Number(candle.close ?? candle.price) / base),
    volume: usable.map((candle) => Number(candle.volume || 0) / volumeScale)
  };
}

class TrajectoryIndex {
  constructor(index = null) {
    this.tokens = Array.isArray(index?.tokens) ? index.tokens : [];
  }

  static load(filePath) {
    if (!fs.existsSync(filePath)) return new TrajectoryIndex();
    return new TrajectoryIndex(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }

  match(candles) {
    const live = normalizeCandles(candles);
    if (live.price.length < 2 || !this.tokens.length) return { label: 'unavailable', confidence: 0, nearestMatches: [], medianHistoricalResults: null, historicalRanges: null };
    const age = Math.min(60, live.price.length - 1);
    const matches = this.tokens.map((token) => {
      let sum = 0;
      let dimensions = 0;
      for (let index = 0; index <= age; index += 1) {
        const priceDelta = live.price[index] - Number(token.normalizedPricePath[index]);
        const volumeDelta = Math.log1p(live.volume[index] || 0) - Math.log1p(Number(token.normalizedVolumePath[index]) || 0);
        sum += priceDelta ** 2 + 0.2 * volumeDelta ** 2;
        dimensions += 1.2;
      }
      return { token, distance: Math.sqrt(sum / Math.max(1, dimensions)) };
    }).sort((a, b) => a.distance - b.distance || a.token.mint.localeCompare(b.token.mint)).slice(0, 3);
    const resultAt = (minute) => median(matches.map((match) => Number(match.token.returns?.[`${minute}m`])).filter(Number.isFinite));
    const median15 = resultAt(15);
    const confidence = Math.max(0, Math.min(1, (age / 10) * (1 / (1 + (matches[0]?.distance || 10) * 4))));
    const label = median15 == null ? 'unavailable' : median15 >= 5 ? 'favorable' : median15 <= -5 ? 'adverse' : 'neutral';
    return {
      label,
      confidence,
      ageMinutes: age,
      nearestMatches: matches.map((match) => ({ mint: match.token.mint, symbol: match.token.symbol, distance: Number(match.distance.toFixed(6)) })),
      medianHistoricalResults: { return5mPct: resultAt(5), return15mPct: median15, return30mPct: resultAt(30) },
      historicalRanges: {
        upsidePct: [Math.min(...matches.map((match) => match.token.maximumFavourableExcursionPct)), Math.max(...matches.map((match) => match.token.maximumFavourableExcursionPct))],
        drawdownPct: [Math.min(...matches.map((match) => match.token.maximumDrawdownPct)), Math.max(...matches.map((match) => match.token.maximumDrawdownPct))]
      }
    };
  }
}

module.exports = { TrajectoryIndex, normalizeCandles };
