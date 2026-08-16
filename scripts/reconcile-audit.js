'use strict';

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

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function collectDailyCsvRows(auditDirectory, prefix) {
  if (!fs.existsSync(auditDirectory)) return [];
  const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.csv$`);
  const files = fs.readdirSync(auditDirectory).filter((name) => pattern.test(name)).sort();
  const rows = [];
  for (const file of files) {
    for (const row of parseCsv(fs.readFileSync(path.join(auditDirectory, file), 'utf8'))) rows.push({ ...row, _file: file });
  }
  return rows;
}

/**
 * The session ledger in state-final.json is the one authoritative trade lifecycle;
 * the append-only trades-*.csv/events-*.csv files are its external audit trail.
 * This reconciles them directly instead of asserting a frozen legacy snapshot,
 * so it keeps working as the session and daily files roll forward.
 */
function reconcile({ projectRoot = path.resolve(__dirname, '..'), stateFile, auditDirectory } = {}) {
  const resolvedStateFile = stateFile || path.join(projectRoot, 'data', 'state-final.json');
  const resolvedAuditDirectory = auditDirectory || path.join(projectRoot, 'data', 'audit');
  const state = loadState(resolvedStateFile);
  const closedTrades = state?.closedTrades || [];

  const tradeRows = collectDailyCsvRows(resolvedAuditDirectory, 'trades');
  const eventRows = collectDailyCsvRows(resolvedAuditDirectory, 'events');
  const tradeRowById = new Map(tradeRows.map((row) => [row.trade_id, row]));

  const missingFromCsv = closedTrades.filter((trade) => !tradeRowById.has(trade.id)).map((trade) => trade.id);
  const stateTradeIds = new Set(closedTrades.map((trade) => trade.id));
  const csvRowsWithoutMatchingSessionTrade = tradeRows.filter((row) => !stateTradeIds.has(row.trade_id)).map((row) => row.trade_id);
  const pnlMismatches = closedTrades
    .filter((trade) => tradeRowById.has(trade.id))
    .map((trade) => ({ id: trade.id, stateNetPnlLamports: String(trade.netPnlLamports), csvNetPnlLamports: tradeRowById.get(trade.id).net_pnl_lamports }))
    .filter((entry) => entry.stateNetPnlLamports !== entry.csvNetPnlLamports);

  const eventTypeCounts = {};
  for (const row of eventRows) eventTypeCounts[row.event_type] = (eventTypeCounts[row.event_type] || 0) + 1;

  const reconciled = missingFromCsv.length === 0 && pnlMismatches.length === 0;
  return {
    stateFile: resolvedStateFile,
    auditDirectory: resolvedAuditDirectory,
    sessionId: state?.session?.id || null,
    performance: state?.performance || null,
    closedTradesInSessionLedger: closedTrades.length,
    dailyTradeCsvFiles: [...new Set(tradeRows.map((row) => row._file))],
    dailyEventCsvFiles: [...new Set(eventRows.map((row) => row._file))],
    eventTypeCounts,
    // A trade the session ledger says closed but with no matching CSV row is the real audit-persistence defect to watch for.
    missingFromCsv,
    // Rows present only in old daily CSVs (older than the session ledger's retained/trimmed history) are expected, not an error.
    csvRowsWithoutMatchingSessionTrade,
    pnlMismatches,
    reconciled
  };
}

function main() {
  const result = reconcile({});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.sessionId) {
    process.stderr.write('No session state found; nothing to reconcile.\n');
    process.exitCode = 1;
    return;
  }
  if (!result.reconciled) {
    process.stderr.write('The audit CSV trail does not reconcile with the authoritative session ledger.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { collectDailyCsvRows, parseCsv, reconcile };
