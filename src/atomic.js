'use strict';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function atomic(value) {
  if (typeof value === 'bigint') return value;
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) throw new TypeError(`Invalid atomic amount: ${text}`);
  return BigInt(text);
}

function decimalToAtomic(value, decimals) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 255) throw new TypeError('Invalid token decimals.');
  const text = String(value ?? '').trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new TypeError(`Invalid decimal amount: ${text}`);
  const sign = match[1] === '-' ? -1n : 1n;
  const integer = match[2];
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  const digits = `${integer}${fraction}`;
  const shift = places - fraction.length + exponent;
  if (shift >= 0) return sign * BigInt(`${digits}${'0'.repeat(shift)}` || '0');
  const cut = digits.length + shift;
  if (cut < 0) {
    if (/[^0]/.test(digits)) throw new RangeError('Decimal amount is below atomic precision.');
    return 0n;
  }
  if (/[^0]/.test(digits.slice(Math.max(0, cut)))) throw new RangeError('Decimal amount exceeds atomic precision.');
  return sign * BigInt(digits.slice(0, Math.max(0, cut)) || '0');
}

function atomicToDecimalString(value, decimals, { trim = true } = {}) {
  const amount = atomic(value);
  const places = Number(decimals);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(places + 1, '0');
  if (!places) return `${sign}${digits}`;
  const integer = digits.slice(0, -places) || '0';
  let fraction = digits.slice(-places);
  if (trim) fraction = fraction.replace(/0+$/, '');
  return fraction ? `${sign}${integer}.${fraction}` : `${sign}${integer}`;
}

function atomicToDisplayNumber(value, decimals) {
  return Number(atomicToDecimalString(value, decimals));
}

function applyBpsFloor(value, bps) {
  const amount = atomic(value);
  const rate = BigInt(Math.trunc(Number(bps)));
  return amount * rate / 10_000n;
}

function applyHaircut(value, haircutBps) {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(Number(haircutBps || 0)))));
  return atomic(value) * (10_000n - bps) / 10_000n;
}

function percentOf(value, percent) {
  const millionths = decimalToAtomic(percent, 6);
  return atomic(value) * millionths / 100_000_000n;
}

function sumAtomic(values) { return values.reduce((total, value) => total + atomic(value), 0n); }

function entryLamportsForUsd(tradeSizeUsd, solUsd) {
  const targetNanoUsd = decimalToAtomic(tradeSizeUsd, 9);
  const solNanoUsd = decimalToAtomic(solUsd, 9);
  if (targetNanoUsd <= 0n || solNanoUsd <= 0n) throw new RangeError('Fresh positive USD target and SOL/USD price are required.');
  return targetNanoUsd * LAMPORTS_PER_SOL / solNanoUsd;
}

function usdMicrosFromLamports(lamports, solUsd) {
  const solNanoUsd = decimalToAtomic(solUsd, 9);
  return atomic(lamports) * solNanoUsd / 1_000_000_000_000n;
}

module.exports = {
  LAMPORTS_PER_SOL, SOL_MINT, applyBpsFloor, applyHaircut, atomic, atomicToDecimalString,
  atomicToDisplayNumber, decimalToAtomic, entryLamportsForUsd, percentOf, sumAtomic, usdMicrosFromLamports
};
