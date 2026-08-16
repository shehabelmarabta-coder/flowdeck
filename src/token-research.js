'use strict';

const BLACKLIST = Object.freeze(['uswr', 'usor', 'usos', 'usoh', 'usop', 'tnos', 'usox', 'vorf', 'aorp', 'saof', 'usur', 'sacf', 'goap', 'mcx', 'live kick', 'uotf', 'usoc', 'xsol', 'saas']);

function safeText(value, maximum = 64) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function numberAt(objects, paths) {
  for (const object of objects) for (const path of paths) {
    let value = object;
    for (const key of path.split('.')) value = value?.[key];
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function booleanAt(objects, paths) {
  for (const object of objects) for (const path of paths) {
    let value = object;
    for (const key of path.split('.')) value = value?.[key];
    if (value === true || value === false) return value;
    if (value === 1 || value === 0) return Boolean(value);
    const text = String(value ?? '').toLowerCase();
    if (['yes', 'true', '1'].includes(text)) return true;
    if (['no', 'false', '0'].includes(text)) return false;
  }
  return null;
}

function hasBlacklistedIdentity(name, symbol) {
  const text = `${safeText(name)} ${safeText(symbol)}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return BLACKLIST.find((term) => {
    const pattern = term.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return new RegExp(`(?:^|\\s)${pattern}(?:$|\\s)`, 'i').test(text);
  }) || null;
}

function tokenIdentity({ mint, gmgnInfo = null, onChain = null } = {}) {
  const gmgnName = safeText(gmgnInfo?.name);
  const gmgnSymbol = safeText(gmgnInfo?.symbol, 20);
  const chainName = safeText(onChain?.name);
  const chainSymbol = safeText(onChain?.symbol, 20);
  const name = gmgnName || chainName || 'Unknown token';
  const symbol = gmgnSymbol || chainSymbol || 'Unknown token';
  return { mint: String(mint || ''), name, symbol, source: gmgnName || gmgnSymbol ? 'GMGN' : chainName || chainSymbol ? 'ON_CHAIN' : 'FALLBACK' };
}

function firstFilter({ identity, info = null, security = null, pool = null, reverseRouteAvailable = false } = {}) {
  if (!reverseRouteAvailable) return { result: 'REJECT', reason: 'NO_EXACT_REVERSE_SELL_ROUTE', flags: ['NO_REVERSE_ROUTE'] };
  const sources = [security || {}, info || {}, pool || {}];
  const blacklisted = hasBlacklistedIdentity(identity?.name, identity?.symbol);
  const mintRenounced = booleanAt(sources, ['renounced_mint']);
  const freezeRenounced = booleanAt(sources, ['renounced_freeze_account']);
  const washTrading = booleanAt(sources, ['is_wash_trading']);
  const rugRatio = numberAt(sources, ['rug_ratio']);
  const top10 = numberAt(sources, ['adjusted_top_10_holder_rate', 'top_10_holder_rate', 'stat.top_10_holder_rate', 'dev.top_10_holder_rate']);
  const liquidityUsd = numberAt(sources, ['liquidity', 'pool.liquidity']);
  const devHold = numberAt(sources, ['dev_team_hold_rate', 'creator_balance_rate', 'stat.dev_team_hold_rate', 'stat.creator_hold_rate']);
  const insiderRate = numberAt(sources, ['suspected_insider_hold_rate', 'rat_trader_amount_rate', 'stat.top_rat_trader_percentage']);
  const bundlerRate = numberAt(sources, ['bundler_trader_amount_rate', 'stat.top_bundler_trader_percentage']);
  const sniperCount = numberAt(sources, ['sniper_count', 'wallet_tags_stat.sniper_wallets']);
  const smartMoney = numberAt(sources, ['wallet_tags_stat.smart_wallets', 'smart_degen_count']) || 0;
  const kol = numberAt(sources, ['wallet_tags_stat.renowned_wallets', 'renowned_count']) || 0;
  const flags = [];
  if (blacklisted) flags.push(`BLACKLISTED_IDENTITY:${blacklisted}`);
  if (mintRenounced === false) flags.push('MINT_AUTHORITY_ACTIVE');
  if (freezeRenounced === false) flags.push('FREEZE_AUTHORITY_ACTIVE');
  if (washTrading === true) flags.push('WASH_TRADING');
  if (rugRatio != null && rugRatio > 0.3) flags.push('RUG_RATIO_HIGH');
  if (top10 != null && top10 > 0.5) flags.push('TOP10_CONCENTRATION_HIGH');
  if (flags.length) return { result: 'REJECT', reason: flags[0], flags, metrics: { rugRatio, top10, liquidityUsd, devHold, insiderRate, bundlerRate, sniperCount, smartMoney, kol } };
  const incomplete = [mintRenounced, freezeRenounced, washTrading, rugRatio, top10, liquidityUsd].some((value) => value == null);
  if (incomplete) flags.push('INCOMPLETE_GMGN_EVIDENCE');
  if (devHold != null && devHold > 0.2) flags.push('ELEVATED_DEV_HOLDING');
  if (insiderRate != null && insiderRate > 0.2) flags.push('ELEVATED_INSIDERS');
  if (bundlerRate != null && bundlerRate > 0.2) flags.push('ELEVATED_BUNDLERS');
  if (sniperCount != null && sniperCount > 20) flags.push('ELEVATED_SNIPERS');
  if (liquidityUsd != null && liquidityUsd < 10_000) flags.push('LOW_LIQUIDITY');
  return {
    result: flags.length ? 'NEEDS_DEEPER_RESEARCH' : 'PASSED_FIRST_FILTER',
    reason: flags[0] || 'DETERMINISTIC_FIRST_FILTER_PASSED', flags,
    metrics: { rugRatio, top10, liquidityUsd, devHold, insiderRate, bundlerRate, sniperCount, smartMoney, kol }
  };
}

module.exports = { BLACKLIST, booleanAt, firstFilter, hasBlacklistedIdentity, numberAt, safeText, tokenIdentity };
