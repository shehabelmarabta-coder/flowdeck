'use strict';

// Read-only Phase 1 decision-support diagnostic. No parameters touched. Breaks down the last
// N routed BUY intents by entry/reverse price impact, modelled friction, wallet source, and
// token lifecycle/liquidity context, to determine whether high friction is representative of
// the tracked-wallet cohort's real token picks or an artifact of specific outlier sources.

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const stateFile = process.argv[2] || path.join(__dirname, '..', 'data', 'state-final.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const intents = state.intents.filter((intent) => intent.side === 'BUY' && intent.initialQuote);
  const candidateById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

  const rows = intents.map((intent) => {
    const candidate = candidateById.get(intent.candidateId);
    const entryImpact = Number(intent.initialQuote?.priceImpactPct);
    const reverseImpact = Number(intent.revalidation?.reverse?.priceImpactPct ?? intent.snapshot?.reverse_quote?.priceImpactPct);
    return {
      symbol: intent.symbol || intent.mint?.slice(0, 8),
      mint: intent.mint,
      entryImpactPct: Number.isFinite(entryImpact) ? entryImpact * 100 : null,
      reverseImpactPct: Number.isFinite(reverseImpact) ? reverseImpact * 100 : null,
      entryRouter: intent.initialQuote?.router || null,
      reverseRouter: intent.revalidation?.reverse?.router || intent.snapshot?.reverse_quote?.router || null,
      frictionPct: intent.stopModel?.frictionPct ?? null,
      rejectReason: intent.stopModel?.rejectReason ?? null,
      lifecycleStage: candidate?.lifecycleStage || 'UNKNOWN',
      liquidityUsd: candidate?.research?.liquidityUsd ?? null,
      wallets: (candidate?.sourceWallets || []).map((w) => w.label || w.address),
      decisionTimestamp: intent.decisionTimestamp
    };
  });

  console.log(`Total routed BUY intents with a quote: ${rows.length}`);

  // --- Friction distribution ---
  const frictions = rows.map((r) => r.frictionPct).filter((v) => Number.isFinite(v));
  function percentileOf(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
  console.log('\n=== Modelled frictionPct distribution ===');
  console.log(`n=${frictions.length}  p10=${percentileOf(frictions, 0.1).toFixed(1)}  p25=${percentileOf(frictions, 0.25).toFixed(1)}  median=${percentileOf(frictions, 0.5).toFixed(1)}  p75=${percentileOf(frictions, 0.75).toFixed(1)}  p90=${percentileOf(frictions, 0.9).toFixed(1)}  max=${Math.max(...frictions).toFixed(1)}`);
  const buckets = [[0, 10], [10, 20], [20, 30], [30, 50], [50, 100], [100, Infinity]];
  for (const [lo, hi] of buckets) {
    const count = frictions.filter((v) => v >= lo && v < hi).length;
    console.log(`  ${String(lo).padStart(3)}-${hi === Infinity ? 'inf' : hi}%: ${count} (${(count / frictions.length * 100).toFixed(0)}%)`);
  }

  // --- Entry vs reverse price impact, raw values ---
  const entryImpacts = rows.map((r) => r.entryImpactPct).filter((v) => Number.isFinite(v));
  const reverseImpacts = rows.map((r) => r.reverseImpactPct).filter((v) => Number.isFinite(v));
  console.log('\n=== Entry priceImpactPct (raw Jupiter field, x100 for %) ===');
  console.log(`n=${entryImpacts.length}  median=${percentileOf(entryImpacts, 0.5).toFixed(2)}%  p90=${percentileOf(entryImpacts, 0.9).toFixed(2)}%  max=${Math.max(...entryImpacts.map(Math.abs)).toFixed(2)}%`);
  console.log('=== Reverse priceImpactPct (raw Jupiter field, x100 for %) ===');
  console.log(`n=${reverseImpacts.length}  median=${percentileOf(reverseImpacts, 0.5).toFixed(2)}%  p90=${percentileOf(reverseImpacts, 0.9).toFixed(2)}%  max=${Math.max(...reverseImpacts.map(Math.abs)).toFixed(2)}%`);

  // --- Outlier / sentinel scan ---
  console.log('\n=== Entries where |priceImpactPct raw fraction| >= 1.0 (implausible as a fraction: >=100%) ===');
  const outliers = rows.filter((r) => Math.abs(Number(r.entryImpactPct) / 100) >= 1.0 || Math.abs(Number(r.reverseImpactPct) / 100) >= 1.0);
  console.log(`${outliers.length} / ${rows.length} routed candidates (${(outliers.length / rows.length * 100).toFixed(1)}%)`);
  for (const r of outliers) {
    console.log(`  ${r.symbol.padEnd(10)} mint=${r.mint.slice(0, 10)}.. entryImpact=${r.entryImpactPct?.toFixed(2)}% reverseImpact=${r.reverseImpactPct?.toFixed(2)}% entryRouter=${r.entryRouter} reverseRouter=${r.reverseRouter} exactly-1=${r.entryImpactPct === -100 || r.reverseImpactPct === -100}`);
  }

  // --- By wallet ---
  console.log('\n=== Median frictionPct by source wallet (wallets with >=2 routed candidates) ===');
  const byWallet = new Map();
  for (const r of rows) {
    for (const wallet of r.wallets) {
      if (!byWallet.has(wallet)) byWallet.set(wallet, []);
      if (Number.isFinite(r.frictionPct)) byWallet.get(wallet).push(r.frictionPct);
    }
  }
  const walletRows = [...byWallet.entries()].filter(([, values]) => values.length >= 2)
    .map(([wallet, values]) => ({ wallet, count: values.length, median: percentileOf(values, 0.5) }))
    .sort((a, b) => b.median - a.median);
  for (const row of walletRows) console.log(`  ${row.wallet.padEnd(24)} n=${row.count}  median frictionPct=${row.median.toFixed(1)}%`);

  // --- By lifecycle stage ---
  console.log('\n=== Median frictionPct by lifecycle stage ===');
  const byStage = new Map();
  for (const r of rows) {
    if (!byStage.has(r.lifecycleStage)) byStage.set(r.lifecycleStage, []);
    if (Number.isFinite(r.frictionPct)) byStage.get(r.lifecycleStage).push(r.frictionPct);
  }
  for (const [stage, values] of byStage) console.log(`  ${stage.padEnd(16)} n=${values.length}  median frictionPct=${values.length ? percentileOf(values, 0.5).toFixed(1) : 'n/a'}%`);

  // --- Liquidity vs friction ---
  console.log('\n=== Liquidity (USD) vs frictionPct (rows with known liquidity) ===');
  const withLiquidity = rows.filter((r) => Number.isFinite(r.liquidityUsd) && Number.isFinite(r.frictionPct));
  console.log(`n=${withLiquidity.length} / ${rows.length} rows have liquidityUsd recorded`);
  for (const r of withLiquidity.slice(-15)) console.log(`  ${r.symbol.padEnd(10)} liquidityUsd=$${Math.round(r.liquidityUsd).toLocaleString()}  frictionPct=${r.frictionPct.toFixed(1)}%`);

  // --- Which specific mints dominate >30% friction ---
  console.log('\n=== Distinct mints contributing to frictionPct >= 30% ===');
  const highFriction = rows.filter((r) => Number(r.frictionPct) >= 30);
  const byMint = new Map();
  for (const r of highFriction) byMint.set(r.mint, (byMint.get(r.mint) || 0) + 1);
  const sortedMints = [...byMint.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`${highFriction.length} rows >= 30% friction, across ${byMint.size} distinct mints`);
  for (const [mint, count] of sortedMints.slice(0, 10)) {
    const sample = highFriction.find((r) => r.mint === mint);
    console.log(`  ${count}x  ${sample.symbol.padEnd(10)} ${mint}`);
  }

  fs.writeFileSync(path.join(__dirname, '..', 'friction-cohort-output.json'), JSON.stringify(rows, null, 2));
  console.log('\nFull row detail written to friction-cohort-output.json');
}

main();
