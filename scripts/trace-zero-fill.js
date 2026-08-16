'use strict';

// Read-only Phase 1 diagnostic. Reads data/state-final.json directly (no live process
// interaction) and traces the last N intents that reached "classification !== AVOID"
// (i.e. actually got routed and attempted), producing a rejection histogram and a
// per-candidate detail table.

const fs = require('node:fs');
const path = require('node:path');

function bi(value) { try { return BigInt(String(value ?? '0')); } catch { return 0n; } }
function pct(numerator, denominator) { return denominator === 0n ? null : Number(numerator * 1_000_000n / denominator) / 10_000; }

function main() {
  const stateFile = process.argv[2] || path.join(__dirname, '..', 'data', 'state-final.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const intents = state.intents.filter((intent) => intent.side === 'BUY' && intent.route && intent.route.length >= 0 && intent.initialQuote);
  const routed = intents.filter((intent) => intent.classification !== 'AVOID' || intent.initialQuote?.ok);
  const last50 = routed.slice(-50);

  const histogram = {};
  for (const intent of last50) {
    const key = intent.reason || intent.status || 'UNKNOWN';
    histogram[key] = (histogram[key] || 0) + 1;
  }
  const sortedHistogram = Object.entries(histogram).sort((a, b) => b[1] - a[1]);

  console.log(`Routed BUY intents inspected: ${last50.length} (of ${intents.length} with an initial quote, ${state.intents.length} total intents retained)`);
  console.log('\n=== Rejection histogram (last 50 routed) ===');
  for (const [reason, count] of sortedHistogram) console.log(`${String(count).padStart(4)}  ${reason}`);

  console.log('\n=== 10 representative routed candidates ===');
  const sample = last50.slice(-10);
  const rows = sample.map((intent) => {
    const entry = intent.initialQuote || {};
    const out = bi(entry.outAmountAtomic);
    const min = bi(intent.minimumOutputAtomic);
    const priceImpactPct = entry.priceImpactPct;
    const priceImpactBps = Math.abs(Number(priceImpactPct ?? 0)) * 10_000;
    const realisticSlippageBps = 40;
    const modelledSlippageBps = Math.min(10_000, Math.max(0, Math.round(priceImpactBps + realisticSlippageBps)));
    const modelled = out > 0n ? out * BigInt(10_000 - modelledSlippageBps) / 10_000n : 0n;
    const modelledVsMin = min > 0n ? pct(modelled - min, min) : null;
    const notionalSol = Number(intent.inputAmountAtomic || 0) / 1e9;
    return {
      symbol: intent.symbol || intent.mint?.slice(0, 6) || '?',
      outAmount: out.toString(),
      minimumOutput: min.toString(),
      priceImpactPct: priceImpactPct ?? 'null',
      modelledSlippageBps,
      modelled: modelled.toString(),
      modelledVsMinPct: modelledVsMin == null ? 'n/a' : `${modelledVsMin.toFixed(2)}%`,
      notionalSol: notionalSol.toFixed(4),
      stopPct: intent.stopModel?.stopPct ?? 'n/a',
      rejectReason: intent.stopModel?.rejectReason ?? null,
      maxLossLamports: intent.stopModel?.maxLossLamports ?? 'n/a',
      worstCaseLossLamports: intent.stopModel?.worstCaseLossLamports ?? 'n/a',
      brainAction: intent.mathematics?.brain?.action ?? 'n/a',
      controlAction: intent.mathematics?.brain?.controlAction ?? 'n/a',
      classification: intent.classification,
      finalReason: intent.reason || intent.status
    };
  });
  for (const row of rows) {
    console.log('---');
    console.log(row);
  }

  fs.writeFileSync(path.join(__dirname, '..', 'trace-zero-fill-output.json'), JSON.stringify({ histogram: Object.fromEntries(sortedHistogram), sample: rows, sampleFull: sample }, null, 2));
  console.log('\nFull detail written to trace-zero-fill-output.json');
}

main();
