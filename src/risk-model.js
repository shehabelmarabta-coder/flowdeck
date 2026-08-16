'use strict';

const { atomic, decimalToAtomic } = require('./atomic');

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function standardDeviation(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (usable.length < 2) return null;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const variance = usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / (usable.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function percentile(values, fraction) {
  const usable = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!usable.length) return null;
  return usable[Math.min(usable.length - 1, Math.floor((usable.length - 1) * fraction))];
}

function percentReturns(prices) {
  const usable = prices.map(Number).filter((price) => Number.isFinite(price) && price > 0);
  const returns = [];
  for (let index = 1; index < usable.length; index += 1) returns.push((usable[index] / usable[index - 1] - 1) * 100);
  return returns;
}

function volatilityPct({ candles = [], returnsPct = [] } = {}) {
  let returns = returnsPct.map(Number).filter(Number.isFinite);
  if (!returns.length) {
    const prices = candles.map((candle) => Number(candle?.close ?? candle?.price)).filter((price) => price > 0);
    returns = prices.slice(1).map((price, index) => Math.log(price / prices[index]) * 100);
  }
  if (returns.length < 2) return null;
  const center = percentile(returns, 0.5);
  const madSigma = Number(percentile(returns.map((value) => Math.abs(value - center)), 0.5)) * 1.4826;
  const clipped = returns.map((value) => clamp(value - center, -4 * Math.max(madSigma, 0.01), 4 * Math.max(madSigma, 0.01)));
  let weight = 1;
  let weightedSquares = 0;
  let totalWeight = 0;
  for (let index = clipped.length - 1; index >= 0; index -= 1) {
    weightedSquares += weight * clipped[index] ** 2;
    totalWeight += weight;
    weight *= 0.8;
  }
  const ewmaSigma = Math.sqrt(weightedSquares / Math.max(totalWeight, 1));
  return Math.max(madSigma, ewmaSigma);
}

function shrunkWinnerMaePct(closedTrades, { priorPct = 6, priorSamples = 20, regime = null } = {}) {
  const byMint = new Map();
  for (const trade of closedTrades || []) {
    if (trade?.executable === false || trade?.status === 'UNSELLABLE_AT_RESET') continue;
    const pnl = Number(trade.netPnlPct ?? trade.realizedNetPnlPct ?? trade.realizedPnlPct);
    const mae = Number(trade.maeBeforeTp1Pct ?? trade.maePct);
    if (!(pnl > 0) || !Number.isFinite(mae)) continue;
    const value = Math.abs(mae);
    const current = byMint.get(trade.mint);
    if (current == null || value > current) byMint.set(trade.mint, value);
  }
  const globalSamples = [...byMint.values()];
  const globalP80 = percentile(globalSamples, 0.8) ?? priorPct;
  const regimeByMint = new Map();
  for (const trade of (closedTrades || []).filter((trade) => {
    if (trade.executable === false) return false;
    if (!(Number(trade.netPnlPct) > 0) || !Number.isFinite(Number(trade.maeBeforeTp1Pct ?? trade.maePct))) return false;
    if (!regime) return true;
    return (!regime.lifecycleStage || trade.lifecycleStage === regime.lifecycleStage)
      && (!regime.liquidityBand || trade.liquidityBand === regime.liquidityBand)
      && (!regime.ageBand || trade.ageBand === regime.ageBand);
  })) {
    const value = Math.abs(Number(trade.maeBeforeTp1Pct ?? trade.maePct));
    if (!regimeByMint.has(trade.mint) || value > regimeByMint.get(trade.mint)) regimeByMint.set(trade.mint, value);
  }
  const regimeSamples = [...regimeByMint.values()];
  const regimeP80 = percentile(regimeSamples, 0.8) ?? globalP80;
  const shrinkWeight = regimeSamples.length / (regimeSamples.length + priorSamples);
  const shrunk = shrinkWeight * regimeP80 + (1 - shrinkWeight) * globalP80;
  return { value: shrunk, regimeP80, globalP80, uniqueMintSamples: globalSamples.length, regimeSamples: regimeSamples.length, shrinkWeight, priorPct, priorSamples };
}

function frictionPct({ inputLamports, immediateReverseLamports, entryFeeLamports = 0n, exitFeeLamports = 0n }) {
  const input = atomic(inputLamports);
  if (input <= 0n) return 0;
  const reverse = atomic(immediateReverseLamports || 0);
  const loss = input > reverse ? input - reverse : 0n;
  const total = loss + atomic(entryFeeLamports) + atomic(exitFeeLamports);
  return Number(total * 1_000_000n / input) / 10_000;
}

function dynamicStop({ config, inputLamports, immediateReverseLamports, entryFeeLamports = 0n, exitFeeLamports = 0n, volatility = null, closedTrades = [], regime = null }) {
  const settings = config.bot.refined;
  const friction = frictionPct({ inputLamports, immediateReverseLamports, entryFeeLamports, exitFeeLamports });
  const mae = shrunkWinnerMaePct(closedTrades, { priorPct: settings.winnerMaePriorPct, priorSamples: settings.regimePriorSamples, regime });
  const sigma = volatility != null && Number.isFinite(Number(volatility)) ? Math.max(0, Number(volatility)) : null;
  const historicalFallbackAvailable = mae.regimeSamples >= 3 || mae.uniqueMintSamples >= 3;
  const coinSpecific = sigma != null || historicalFallbackAvailable;
  const noisePct = coinSpecific
    ? Math.max(sigma == null ? 0 : 2 * sigma, mae.value)
    : Math.max(0, settings.fallbackStopPct - friction);
  const rawStopPct = coinSpecific ? Math.max(0, friction + noisePct) : Math.max(settings.fallbackStopPct, friction);
  const stopPct = clamp(rawStopPct, settings.minStopPct, settings.maxStopPct);
  const tooWide = rawStopPct > settings.maxStopPct;
  const maxLossLamports = decimalToAtomic(settings.maxLossSol, 9);
  const stopMillionths = decimalToAtomic(stopPct, 6);
  const maxInputLamports = stopMillionths > 0n ? maxLossLamports * 100_000_000n / stopMillionths : 0n;
  const requested = atomic(inputLamports);
  // stopPct is measured on net executable P&L and already contains friction/fees.
  const worstCaseLossLamports = requested * stopMillionths / 100_000_000n;
  const absoluteRiskExceeded = worstCaseLossLamports > maxLossLamports;
  return {
    modelVersion: settings.stopModelVersion,
    frictionPct: friction,
    volatilitySigmaPct: sigma,
    shrunkMaePct: mae.value,
    noisePct,
    evidence: coinSpecific ? 'COIN_SPECIFIC' : 'FALLBACK_INSUFFICIENT_EVIDENCE',
    fallbackApplied: !coinSpecific,
    winnerMae: mae,
    rawStopPct,
    stopPct,
    tooWide,
    riskOverride: Boolean(tooWide && settings.allowRiskTooWideResearch),
    absoluteRiskExceeded,
    rejectReason: tooWide && !settings.allowRiskTooWideResearch ? 'RISK_TOO_WIDE' : absoluteRiskExceeded ? 'MAX_LOSS_EXCEEDED' : null,
    maxLossLamports: maxLossLamports.toString(),
    maxInputLamports: maxInputLamports.toString(),
    requestedInputLamports: requested.toString(),
    sizedInputLamports: requested.toString(),
    worstCaseLossLamports: worstCaseLossLamports.toString()
  };
}

function tightenStop({ frozenStopPct, currentStopPct, mfePct, breakevenMfePct }) {
  const frozen = Math.abs(Number(frozenStopPct));
  const current = Number.isFinite(Number(currentStopPct)) ? Math.abs(Number(currentStopPct)) : frozen;
  let next = Math.min(frozen, current);
  if (Number(mfePct) >= Number(breakevenMfePct)) next = Math.min(next, 0);
  return next;
}

function runnerTrailPct({ sigmaPct, friction, minimum = 6, maximum = 15, multiplier = 1.5 }) {
  const sigma = Number.isFinite(Number(sigmaPct)) ? Math.max(0, Number(sigmaPct)) : 0;
  return clamp(multiplier * sigma + Math.max(0, Number(friction || 0)), minimum, maximum);
}

module.exports = { clamp, dynamicStop, frictionPct, percentReturns, runnerTrailPct, shrunkWinnerMaePct, standardDeviation, tightenStop, volatilityPct };
