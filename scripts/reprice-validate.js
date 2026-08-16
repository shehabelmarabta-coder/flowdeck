'use strict';

// Read-only Step 0 validation for the v3.1 fill-pricing diagnosis.
// Touches no config, no live code, no running process. Reads the existing
// trades-YYYY-MM-DD.csv, pulls each row's already-recorded entry/exit quote
// bases (raw quoted outAmount vs. the minimumOutputAtomic floor that was
// actually used to price the fill), and recomputes net P&L under the
// "quoted outAmount" basis on both legs instead of the floor basis.
//
// This does not implement the full Fix 1 formula (outAmount minus modelled
// slippage) because per-trade priceImpactPct is not persisted in the trade
// row and the live intents that held it have since rolled over. It
// reproduces the simpler "repriced at quoted outAmount on both sides"
// comparison point named in the diagnosis, which is the number this script
// exists to validate before Fix 1 is implemented.

const fs = require('node:fs');
const path = require('node:path');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function bi(value) { return BigInt(String(value || '0').trim() || '0'); }

function reprice(row) {
  const trade = JSON.parse(row.record_json).trade;
  const inputLamports = bi(trade.inputLamports);
  const feesLamports = bi(trade.feesLamports);

  const entryConservative = bi(trade.entryConservativeTokenAtomic);
  const entryExpected = bi(trade.entryExpectedTokenAtomic);
  const exitConservative = bi(trade.conservativeExitProceedsLamports);
  const exitExpected = bi(trade.expectedExitProceedsLamports);

  // Booked (broken) accounting: both legs already priced at the floor.
  const bookedNetPnlLamports = bi(trade.netPnlLamports);
  const bookedNetPnlPct = Number(trade.netPnlPct);

  // Entry haircut actually booked: how much smaller the floor fill was than the raw quote.
  const entryHaircutPct = entryExpected > 0n ? (1 - Number(entryConservative) / Number(entryExpected)) * 100 : 0;
  const exitHaircutPct = exitExpected > 0n ? (1 - Number(exitConservative) / Number(exitExpected)) * 100 : 0;

  // Repriced at quoted outAmount on both legs: hold the raw entry quantity,
  // and scale the exit leg's raw quote proportionally since more tokens
  // held means more tokens sold. If the exit ever failed to quote
  // (expected == conservative == 0 fallback), skip scaling and fall back
  // to the exit's own raw figure directly.
  const entryScale = entryConservative > 0n ? Number(entryExpected) / Number(entryConservative) : 1;
  const repricedExitProceedsLamports = BigInt(Math.round(Number(exitExpected) * entryScale));
  const repricedNetPnlLamports = repricedExitProceedsLamports - inputLamports - feesLamports;
  const repricedNetPnlPct = inputLamports > 0n ? Number(repricedNetPnlLamports * 1_000_000n / inputLamports) / 10_000 : 0;

  return {
    symbol: trade.symbol, mint: trade.mint,
    inputLamports: inputLamports.toString(),
    entryHaircutPct: Number(entryHaircutPct.toFixed(2)),
    exitHaircutPct: Number(exitHaircutPct.toFixed(2)),
    bookedNetPnlPct: Number(bookedNetPnlPct.toFixed(2)),
    repricedNetPnlPct: Number(repricedNetPnlPct.toFixed(2)),
    bookedNetPnlLamports: bookedNetPnlLamports.toString(),
    repricedNetPnlLamports: repricedNetPnlLamports.toString()
  };
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'data', 'audit', 'trades-2026-08-15.csv');
  const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter((row) => row.status === 'CLOSED' || row.exit_timestamp_utc);
  const results = rows.map(reprice);

  const bookedTotalPct = results.reduce((sum, item) => sum + item.bookedNetPnlPct, 0);
  const repricedTotalPct = results.reduce((sum, item) => sum + item.repricedNetPnlPct, 0);
  const entryHaircuts = results.map((item) => item.entryHaircutPct);
  const exitHaircuts = results.map((item) => item.exitHaircutPct);

  console.log(`Trades: ${results.length}`);
  console.log('symbol'.padEnd(12), 'entryHC%'.padStart(9), 'exitHC%'.padStart(9), 'booked%'.padStart(9), 'repriced%'.padStart(10));
  for (const item of results) {
    console.log(
      item.symbol.padEnd(12),
      String(item.entryHaircutPct).padStart(9),
      String(item.exitHaircutPct).padStart(9),
      String(item.bookedNetPnlPct).padStart(9),
      String(item.repricedNetPnlPct).padStart(10)
    );
  }
  console.log('');
  console.log(`Entry haircut range: ${Math.min(...entryHaircuts).toFixed(1)}% - ${Math.max(...entryHaircuts).toFixed(1)}%`);
  console.log(`Exit haircut range:  ${Math.min(...exitHaircuts).toFixed(1)}% - ${Math.max(...exitHaircuts).toFixed(1)}%`);
  console.log(`Booked total net %:    ${bookedTotalPct.toFixed(1)}%`);
  console.log(`Repriced total net %:  ${repricedTotalPct.toFixed(1)}%`);
  const jennie = results.find((item) => item.symbol === 'JENNIE');
  const pumpbr = results.find((item) => item.symbol === 'PumpBR');
  if (jennie) console.log(`JENNIE: booked ${jennie.bookedNetPnlPct}% -> repriced ${jennie.repricedNetPnlPct}%`);
  if (pumpbr) console.log(`PumpBR: booked ${pumpbr.bookedNetPnlPct}% -> repriced ${pumpbr.repricedNetPnlPct}%`);
}

main();
