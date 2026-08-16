'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'paper-audit-v1';
const V3_SCHEMA_VERSION = 'flowdeck-paper-v3';
const MAX_LEGACY_DEDUPE_SCAN_BYTES = 8 * 1024 * 1024;
const EVENT_HEADERS = [
  'schema_version', 'strategy_version', 'session_id', 'event_id', 'decision_id', 'trade_id',
  'timestamp_utc', 'event_type', 'mint', 'symbol', 'lifecycle_stage', 'source_wallet',
  'source_signature', 'wallet_weight', 'wallet_count', 'consensus_pct', 'candidate_state',
  'decision', 'rejection_reason', 'bonding_pct', 'market_cap_usd', 'liquidity_usd',
  'risk_flags', 'trajectory_label', 'trajectory_confidence', 'price_source', 'fill_quality',
  'pricing_unit', 'observed_price_or_index', 'execution_price_or_index', 'price_age_ms',
  'position_stage', 'amount_sol', 'entry_value', 'current_value', 'pnl_sol', 'pnl_pct',
  'mfe_pct', 'mae_pct', 'hold_ms', 'tp1_hit', 'exit_reason', 'detection_to_decision_ms',
  'decision_to_fill_ms', 'modeled_fees_sol', 'modeled_slippage_sol', 'notes'
];

const TRADE_HEADERS = [
  'schema_version', 'strategy_version', 'session_id', 'trade_id', 'decision_id', 'mint', 'symbol',
  'lifecycle_stage_at_entry', 'source_wallets', 'source_signatures', 'wallet_count',
  'entry_consensus_pct', 'primary_wallet_weight', 'entry_reason', 'fill_quality', 'pricing_unit',
  'entry_signal_timestamp_utc', 'decision_timestamp_utc', 'entry_fill_timestamp_utc', 'entry_latency_ms',
  'amount_invested_sol', 'entry_price_or_index', 'tp1_timestamp_utc', 'tp1_price_or_index',
  'final_exit_timestamp_utc', 'final_exit_price_or_index', 'exit_reason', 'total_hold_ms',
  'gross_proceeds_sol', 'modeled_slippage_sol', 'platform_fee_sol', 'network_fee_sol',
  'priority_fee_sol', 'total_modeled_fees_sol', 'net_proceeds_sol', 'realized_net_pnl_sol',
  'realized_net_pnl_pct', 'mfe_pct', 'mae_pct', 'maximum_consensus_pct_after_entry',
  'bonding_pct_at_entry', 'liquidity_usd_at_entry', 'market_cap_usd_at_entry', 'risk_flags',
  'trajectory_label', 'trajectory_confidence', 'observed_plus_15_before_exit',
  'observed_plus_50_before_exit', 'observed_2x_before_exit', 'observed_4x_before_exit',
  'used_executable_price', 'used_proxy_index', 'notes'
];

const QUOTE_HEADERS = [
  'schema_version', 'session_id', 'quote_id', 'decision_id', 'position_id', 'snapshot_id', 'timestamp_utc',
  'purpose', 'input_mint', 'output_mint', 'input_amount_atomic', 'output_amount_atomic',
  'minimum_output_atomic', 'input_decimals', 'output_decimals', 'input_display', 'output_display',
  'request_id', 'router', 'mode', 'price_quality', 'transaction_present', 'request_timestamp_utc',
  'response_timestamp_utc', 'latency_ms', 'quote_age_ms', 'fee_bps', 'fee_mint',
  'platform_fee_amount_atomic', 'platform_fee_bps', 'haircut_bps', 'http_status', 'error_code',
  'error_message', 'cached', 'notes'
];
const FILL_HEADERS = [
  'schema_version', 'strategy_version', 'session_id', 'fill_id', 'position_id', 'decision_id',
  'snapshot_id', 'timestamp_utc', 'side', 'exit_stage', 'input_mint', 'output_mint',
  'input_amount_atomic', 'output_amount_atomic', 'input_decimals', 'output_decimals',
  'input_display', 'output_display', 'quote_id', 'quote_request_id', 'router', 'price_quality',
  'entry_spend_lamports', 'allocated_entry_spend_lamports', 'platform_fee_lamports',
  'network_fee_lamports', 'priority_fee_lamports', 'other_fee_lamports', 'total_cost_lamports',
  'execution_haircut_bps', 'resulting_token_balance_atomic', 'realized_pnl_lamports', 'notes'
];
const SNAPSHOT_HEADERS = [
  'schema_version', 'session_id', 'snapshot_id', 'decision_id', 'position_id', 'timestamp_utc',
  'strategy_version', 'config_hash', 'code_version', 'mint', 'symbol', 'lifecycle_stage',
  'signal_signature', 'signal_slot', 'signal_commitment', 'source_wallet', 'wallet_cluster',
  'wallet_count', 'independent_cluster_count', 'action', 'evidence_grade', 'hard_gate',
  'tp1_posterior_mean', 'tp1_credible_low', 'tp1_credible_high', 'final_posterior_mean',
  'final_credible_low', 'final_credible_high', 'expected_net_sol', 'entry_input_atomic',
  'entry_output_atomic', 'reverse_output_atomic', 'token_decimals', 'snapshot_hash', 'snapshot_json'
];
const OUTCOME_HEADERS = [
  'schema_version', 'session_id', 'outcome_id', 'decision_id', 'position_id', 'snapshot_id',
  'timestamp_utc', 'cohort', 'mint', 'symbol', 'source_wallet', 'signal_signature', 'reason',
  'baseline_timestamp_utc', 'baseline_quality', 'baseline_value', 'horizon_ms',
  'observation_timestamp_utc', 'observation_quality', 'observation_value', 'return_pct',
  'available', 'censored', 'actual_pnl_eligible', 'notes'
];
const MANIFEST_HEADERS = [
  'schema_version', 'session_id', 'manifest_id', 'timestamp_utc', 'event', 'start_timestamp_utc',
  'end_timestamp_utc', 'strategy_version', 'control_strategy_version', 'config_hash', 'code_version',
  'rpc_hostname', 'wallet_roster_hash', 'enabled_wallet_count', 'jupiter_available',
  'paper_taker_configured', 'counterfactual_horizons_ms', 'restart_count', 'data_gap', 'notes'
];
const V3_TRADE_HEADERS = [
  'schema_version', 'strategy_version', 'session_id', 'trade_id', 'position_id', 'decision_id',
  'snapshot_id', 'mint', 'symbol', 'lifecycle_stage', 'entry_timestamp_utc', 'final_exit_timestamp_utc',
  'exit_reason', 'entry_spend_lamports', 'explicit_modelled_costs_lamports',
  'total_exit_proceeds_lamports', 'net_pnl_lamports', 'net_pnl_sol', 'net_pnl_pct',
  'entry_token_amount_atomic', 'final_token_balance_atomic', 'token_decimals', 'entry_quote_id',
  'tp1_fill_id', 'final_fill_id', 'price_quality', 'tp1_hit', 'mfe_pct', 'mae_pct',
  'wallet_count_at_entry', 'independent_cluster_count_at_entry', 'source_wallets',
  'source_signatures', 'entry_consensus_pct', 'brain_evidence_grade', 'brain_expected_net_sol',
  'observed_plus_15_before_exit', 'observed_plus_50_before_exit', 'observed_2x_before_exit',
  'observed_4x_before_exit', 'notes'
];

const V3_KINDS = {
  quotes: { headers: QUOTE_HEADERS, id: 'quote_id' }, fills: { headers: FILL_HEADERS, id: 'fill_id' },
  snapshots: { headers: SNAPSHOT_HEADERS, id: 'snapshot_id' }, outcomes: { headers: OUTCOME_HEADERS, id: 'outcome_id' },
  manifests: { headers: MANIFEST_HEADERS, id: 'manifest_id' }, 'v3-trades': { headers: V3_TRADE_HEADERS, id: 'trade_id' }
};

function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { cells.push(value); value = ''; }
    else value += character;
  }
  cells.push(value);
  return cells;
}

function utcDate(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

class CsvAuditWriter {
  constructor({ directory, clock = () => Date.now(), secrets = () => [] }) {
    this.directory = path.resolve(directory);
    this.clock = clock;
    this.secrets = secrets;
    this.knownIds = new Map();
    this.eventQueue = [];
    this.eventQueueScheduled = false;
    this.eventsWritten = 0;
    this.tradesWritten = 0;
    this.lastWriteAt = null;
    this.rowsWritten = Object.fromEntries(Object.keys(V3_KINDS).map((kind) => [kind, 0]));
    this.reconciliationCache = null;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  _path(kind, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Audit date must use YYYY-MM-DD.');
    const prefix = V3_KINDS[kind] ? 'flowdeck-v3' : 'flowdeck-paper';
    const fileKind = kind === 'v3-trades' ? 'trades' : kind;
    return path.join(this.directory, `${prefix}-${fileKind}-${date}.csv`);
  }

  _redact(value) {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    for (const secret of this.secrets().filter(Boolean)) text = text.replaceAll(String(secret), '[REDACTED]');
    text = text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED PEM]');
    text = text.replace(/GMGN_(?:API_KEY|PRIVATE_KEY)\s*=\s*[^\s,;]+/gi, 'GMGN_SECRET=[REDACTED]');
    text = text.replace(/JUPITER_API_KEY\s*=\s*[^\s,;]+/gi, 'JUPITER_API_KEY=[REDACTED]');
    text = text.replace(/(?:x-api-key|api[_-]?key)\s*[:=]\s*["']?[^\s,"';}]+/gi, 'api_key=[REDACTED]');
    return text;
  }

  _ids(filePath, headers, idHeader) {
    const cacheKey = `${filePath}:${idHeader}`;
    if (this.knownIds.has(cacheKey)) return this.knownIds.get(cacheKey);
    const ids = new Set();
    const indexDirectory = path.join(this.directory, '.dedupe');
    const indexPath = path.join(indexDirectory, `${path.basename(filePath)}.${idHeader}.jsonl`);
    if (fs.existsSync(indexPath)) {
      for (const line of fs.readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try { ids.add(JSON.parse(line)); } catch { /* Ignore a partial final index write. */ }
      }
    } else if (fs.existsSync(filePath) && fs.statSync(filePath).size <= MAX_LEGACY_DEDUPE_SCAN_BYTES) {
      const index = headers.indexOf(idHeader);
      for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(1)) {
        if (!line) continue;
        const id = parseCsvLine(line)[index];
        if (id) ids.add(id);
      }
    }
    fs.mkdirSync(indexDirectory, { recursive: true });
    if (!fs.existsSync(indexPath)) {
      const contents = [...ids].map((id) => JSON.stringify(id)).join('\n');
      fs.writeFileSync(indexPath, contents ? `${contents}\n` : '', 'utf8');
    }
    ids.indexPath = indexPath;
    this.knownIds.set(cacheKey, ids);
    return ids;
  }

  _append(kind, headers, idHeader, row) {
    const timestamp = row.timestamp_utc || row.final_exit_timestamp_utc || new Date(this.clock()).toISOString();
    const date = utcDate(timestamp);
    const filePath = this._path(kind, date);
    const id = String(row[idHeader] || '');
    if (!id) throw new Error(`${idHeader} is required for audit rows.`);
    const ids = this._ids(filePath, headers, idHeader);
    if (ids.has(id)) return { written: false, duplicate: true, filePath };
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) fs.appendFileSync(filePath, `${headers.join(',')}\r\n`, 'utf8');
    const clean = Object.fromEntries(headers.map((header) => [header, this._redact(row[header])]));
    fs.appendFileSync(filePath, `${headers.map((header) => csvEscape(clean[header])).join(',')}\r\n`, 'utf8');
    fs.mkdirSync(path.dirname(ids.indexPath), { recursive: true });
    fs.appendFileSync(ids.indexPath, `${JSON.stringify(id)}\n`, 'utf8');
    ids.add(id);
    this.lastWriteAt = this.clock();
    this.reconciliationCache = null;
    if (kind === 'events') this.eventsWritten += 1;
    else if (kind === 'trades') this.tradesWritten += 1;
    else this.rowsWritten[kind] = (this.rowsWritten[kind] || 0) + 1;
    return { written: true, filePath };
  }

  writeEvent(row) {
    return this._append('events', EVENT_HEADERS, 'event_id', { schema_version: SCHEMA_VERSION, ...row });
  }

  queueEvent(row) {
    this.eventQueue.push(row);
    this._scheduleEventFlush();
    return { written: false, queued: true };
  }

  _scheduleEventFlush() {
    if (this.eventQueueScheduled) return;
    this.eventQueueScheduled = true;
    setImmediate(() => {
      this.eventQueueScheduled = false;
      this._flushEventBatch();
      if (this.eventQueue.length) this._scheduleEventFlush();
    });
  }

  _flushEventBatch(limit = 25) {
    for (const row of this.eventQueue.splice(0, limit)) {
      try { this.writeEvent(row); } catch (error) { process.stderr.write(`FlowDeck audit write failed: ${error.message}\n`); }
    }
  }

  flushEvents() {
    while (this.eventQueue.length) this._flushEventBatch();
  }

  writeTrade(row) {
    return this._append('trades', TRADE_HEADERS, 'trade_id', { schema_version: SCHEMA_VERSION, ...row });
  }

  writeQuote(row) { return this._append('quotes', QUOTE_HEADERS, 'quote_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }
  writeFill(row) { return this._append('fills', FILL_HEADERS, 'fill_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }
  writeSnapshot(row) { return this._append('snapshots', SNAPSHOT_HEADERS, 'snapshot_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }
  writeOutcome(row) { return this._append('outcomes', OUTCOME_HEADERS, 'outcome_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }
  writeManifest(row) { return this._append('manifests', MANIFEST_HEADERS, 'manifest_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }
  writeV3Trade(row) { return this._append('v3-trades', V3_TRADE_HEADERS, 'trade_id', { schema_version: V3_SCHEMA_VERSION, ...row }); }

  read(kind, date = utcDate(this.clock())) {
    if (!['events', 'trades', ...Object.keys(V3_KINDS)].includes(kind)) throw new Error('Unknown audit export kind.');
    if (kind === 'events') this.flushEvents();
    const filePath = this._path(kind, date);
    const headers = kind === 'events' ? EVENT_HEADERS : kind === 'trades' ? TRADE_HEADERS : V3_KINDS[kind].headers;
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : `${headers.join(',')}\r\n`;
  }

  _readRows(kind, date = utcDate(this.clock())) {
    const lines = this.read(kind, date).split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || '');
    return lines.map((line) => {
      const cells = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    });
  }

  reconcileV3(date = utcDate(this.clock()), sessionId = '') {
    const cacheKey = `${date}:${sessionId}`;
    if (this.reconciliationCache?.key === cacheKey) return this.reconciliationCache.value;
    const filter = (kind) => this._readRows(kind, date).filter((row) => !sessionId || row.session_id === sessionId);
    const trades = filter('v3-trades');
    const fills = filter('fills');
    const sum = (rows, key) => rows.reduce((total, row) => total + (/^-?\d+$/.test(row[key]) ? BigInt(row[key]) : 0n), 0n);
    const invariantMismatches = trades.filter((trade) => {
      const expected = BigInt(trade.total_exit_proceeds_lamports || 0) - BigInt(trade.entry_spend_lamports || 0) - BigInt(trade.explicit_modelled_costs_lamports || 0);
      return expected.toString() !== trade.net_pnl_lamports;
    }).map((trade) => trade.trade_id);
    const value = {
      date, sessionId, quotes: filter('quotes').length, fills: fills.length,
      snapshots: filter('snapshots').length, outcomes: filter('outcomes').length,
      manifests: filter('manifests').length, trades: trades.length,
      entrySpendLamports: sum(trades, 'entry_spend_lamports').toString(),
      explicitModeledCostsLamports: sum(trades, 'explicit_modelled_costs_lamports').toString(),
      totalExitProceedsLamports: sum(trades, 'total_exit_proceeds_lamports').toString(),
      netPnlLamports: sum(trades, 'net_pnl_lamports').toString(),
      fillRealizedPnlLamports: sum(fills, 'realized_pnl_lamports').toString(),
      invariantMismatches, reconciled: invariantMismatches.length === 0
    };
    this.reconciliationCache = { key: cacheKey, value };
    return value;
  }

  status() {
    return {
      enabled: true,
      eventsWritten: this.eventsWritten,
      tradesWritten: this.tradesWritten,
      lastWriteAt: this.lastWriteAt,
      pendingEventRows: this.eventQueue.length,
      directory: this.directory,
      rowsWritten: { ...this.rowsWritten }
    };
  }
}

module.exports = {
  CsvAuditWriter, EVENT_HEADERS, FILL_HEADERS, MANIFEST_HEADERS, OUTCOME_HEADERS, QUOTE_HEADERS,
  SCHEMA_VERSION, SNAPSHOT_HEADERS, TRADE_HEADERS, V3_SCHEMA_VERSION, V3_TRADE_HEADERS,
  csvEscape, parseCsvLine, utcDate
};
