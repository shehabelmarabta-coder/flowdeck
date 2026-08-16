'use strict';

const { ADDRESS_RE } = require('./engine');
const { atomicToDisplayNumber, decimalToAtomic } = require('./atomic');

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD1Jp9VLBwmh2Yk4jWwJxdu'
]);

function tokenAmount(entry) {
  const decimals = Number.isInteger(Number(entry?.uiTokenAmount?.decimals)) ? Number(entry.uiTokenAmount.decimals) : 0;
  const raw = entry?.uiTokenAmount?.amount;
  const amountAtomic = /^\d+$/.test(String(raw || ''))
    ? BigInt(raw)
    : decimalToAtomic(entry?.uiTokenAmount?.uiAmountString ?? entry?.uiTokenAmount?.uiAmount ?? '0', decimals);
  return { amountAtomic, decimals };
}

function ownerOf(entry) {
  return typeof entry?.owner === 'string' ? entry.owner : '';
}

function walletSolDeltaAtomic(transaction, wallet) {
  const keys = transaction.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((key) => String(typeof key === 'string' ? key : key?.pubkey || '') === wallet);
  if (index < 0) return 0n;
  const pre = transaction.meta?.preBalances?.[index];
  const post = transaction.meta?.postBalances?.[index];
  return /^\d+$/.test(String(pre)) && /^\d+$/.test(String(post)) ? BigInt(post) - BigInt(pre) : 0n;
}

function walletSolDelta(transaction, wallet) { return atomicToDisplayNumber(walletSolDeltaAtomic(transaction, wallet), 9); }

function hasSwapInstruction(transaction) {
  const logs = (transaction.meta?.logMessages || []).join('\n');
  return /instruction:\s*(swap|route|buy|sell)|program log:.*\b(swap|route|buy|sell)\b/i.test(logs);
}

function parseWalletSwaps(transaction, wallet, metadata = {}) {
  if (!transaction?.meta || !ADDRESS_RE.test(String(wallet || ''))) return [];
  const before = new Map();
  const after = new Map();
  for (const entry of transaction.meta.preTokenBalances || []) {
    if (ownerOf(entry) !== wallet || !entry.mint) continue;
    const next = tokenAmount(entry); const current = before.get(entry.mint) || { amountAtomic: 0n, decimals: next.decimals };
    before.set(entry.mint, { amountAtomic: current.amountAtomic + next.amountAtomic, decimals: next.decimals });
  }
  for (const entry of transaction.meta.postTokenBalances || []) {
    if (ownerOf(entry) !== wallet || !entry.mint) continue;
    const next = tokenAmount(entry); const current = after.get(entry.mint) || { amountAtomic: 0n, decimals: next.decimals };
    after.set(entry.mint, { amountAtomic: current.amountAtomic + next.amountAtomic, decimals: next.decimals });
  }

  const signature = transaction.transaction?.signatures?.[0] || metadata.signature || '';
  const observedAt = Number.isFinite(transaction.blockTime) ? transaction.blockTime * 1000 : Date.now();
  const nativeSolDeltaAtomic = walletSolDeltaAtomic(transaction, wallet);
  const nativeSolDelta = atomicToDisplayNumber(nativeSolDeltaAtomic, 9);
  const swapInstruction = hasSwapInstruction(transaction);
  const quoteDeltas = [...QUOTE_MINTS].map((mint) => {
    const pre = before.get(mint) || { amountAtomic: 0n, decimals: after.get(mint)?.decimals || 0 };
    const post = after.get(mint) || { amountAtomic: 0n, decimals: pre.decimals };
    return { mint, deltaAtomic: post.amountAtomic - pre.amountAtomic, decimals: post.decimals };
  });
  const quoteDelta = quoteDeltas.reduce((sum, item) => sum + atomicToDisplayNumber(item.deltaAtomic, item.decimals), 0);
  const events = [];
  const mints = new Set([...before.keys(), ...after.keys()]);
  for (const mint of mints) {
    if (!ADDRESS_RE.test(mint) || QUOTE_MINTS.has(mint)) continue;
    const pre = before.get(mint) || { amountAtomic: 0n, decimals: after.get(mint)?.decimals || 0 };
    const post = after.get(mint) || { amountAtomic: 0n, decimals: pre.decimals };
    const deltaAtomic = post.amountAtomic - pre.amountAtomic;
    if (deltaAtomic === 0n) continue;
    const decimals = post.decimals;
    const delta = atomicToDisplayNumber(deltaAtomic, decimals);
    const preAmount = atomicToDisplayNumber(pre.amountAtomic, decimals);
    const postAmount = atomicToDisplayNumber(post.amountAtomic, decimals);
    const side = deltaAtomic > 0n ? 'buy' : 'sell';
    const opposingQuoteFlow = side === 'buy' ? quoteDeltas.some((item) => item.deltaAtomic < 0n) : quoteDeltas.some((item) => item.deltaAtomic > 0n);
    const opposingSolFlow = side === 'buy' ? nativeSolDeltaAtomic < -20_000n : nativeSolDeltaAtomic > 20_000n;
    if (!swapInstruction && !opposingQuoteFlow && !opposingSolFlow) continue;
    events.push({
      id: `${signature}:${wallet}:${mint}:${side}`,
      signature,
      wallet,
      walletLabel: metadata.walletLabel || '',
      mint,
      side,
      tokenDelta: delta,
      tokenDeltaAtomic: deltaAtomic.toString(),
      tokenDecimals: decimals,
      quoteTokenDelta: quoteDelta,
      quoteTokenDeltasAtomic: Object.fromEntries(quoteDeltas.map((item) => [item.mint, { amount: item.deltaAtomic.toString(), decimals: item.decimals }])),
      nativeSolDelta,
      nativeSolDeltaLamports: nativeSolDeltaAtomic.toString(),
      sourcePriceSol: Math.abs(nativeSolDelta) > 0.00002 ? Math.abs(nativeSolDelta / delta) : null,
      preTokenAmount: preAmount,
      postTokenAmount: postAmount,
      preTokenAmountAtomic: pre.amountAtomic.toString(),
      postTokenAmountAtomic: post.amountAtomic.toString(),
      fraction: side === 'sell' && preAmount > 0 ? Math.min(1, Math.abs(delta) / preAmount) : null,
      observedAt,
      source: 'solana-rpc'
    });
  }
  return events;
}

module.exports = { QUOTE_MINTS, hasSwapInstruction, parseWalletSwaps, tokenAmount, walletSolDelta, walletSolDeltaAtomic };
