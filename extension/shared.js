(function installFlowDeckShared(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowDeckShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function makeFlowDeckShared() {
  'use strict';

  const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const SUBSCRIPT_DIGITS = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9'
  };

  function isAddress(value) {
    return ADDRESS_RE.test(String(value || '').trim());
  }

  function decodeCompactSmallNumber(text) {
    const normalized = String(text || '').replaceAll(',', '').trim();
    const match = normalized.match(/0\.0([₀₁₂₃₄₅₆₇₈₉]+)(\d+(?:\.\d+)?)/);
    if (!match) return normalized;
    const zeroCount = Number([...match[1]].map((digit) => SUBSCRIPT_DIGITS[digit]).join(''));
    if (!Number.isInteger(zeroCount) || zeroCount < 1 || zeroCount > 100) return normalized;
    return normalized.replace(match[0], `0.${'0'.repeat(zeroCount)}${match[2]}`);
  }

  function parseCompactNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const decoded = decodeCompactSmallNumber(value);
    const match = decoded.replaceAll(',', '').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*([kmbt])?/i);
    if (!match) return null;
    const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(match[1] || '').toLowerCase()] || 1;
    const result = Number(match[0].replace(/[kmbt\s]/gi, '')) * multiplier;
    return Number.isFinite(result) ? result : null;
  }

  function extractMintFromUrl(input) {
    let text;
    try {
      text = new URL(String(input), 'https://gmgn.ai').href;
    } catch {
      text = String(input || '');
    }
    const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (isAddress(matches[index])) return matches[index];
    }
    return '';
  }

  function pickNumber(object, keys) {
    for (const key of keys) {
      const value = parseCompactNumber(object?.[key]);
      if (value != null) return value;
    }
    return null;
  }

  function pickAddress(object, keys) {
    for (const key of keys) {
      const value = String(object?.[key] || '').trim();
      if (isAddress(value)) return value;
    }
    return '';
  }

  function formatSol(value, maximumFractionDigits = 4) {
    const number = Number(value || 0);
    return `${number < 0 ? '-' : ''}${Math.abs(number).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits
    })}`;
  }

  function formatUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    if (Math.abs(number) >= 1) return `$${number.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
    return `$${number.toPrecision(5)}`;
  }

  function formatPct(value) {
    const number = Number(value || 0);
    return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
  }

  return {
    ADDRESS_RE,
    decodeCompactSmallNumber,
    extractMintFromUrl,
    formatPct,
    formatSol,
    formatUsd,
    isAddress,
    parseCompactNumber,
    pickAddress,
    pickNumber
  };
});
