'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'flowdeck-final-audit-v1';
const HEADERS = Object.freeze({
  events: ['schema_version', 'session_id', 'event_id', 'timestamp_utc', 'event_type', 'decision_id', 'position_id', 'mint', 'side', 'status', 'reason', 'payload_json'],
  trades: [
    'schema_version', 'strategy_version', 'stop_model_version', 'session_id', 'trade_id', 'decision_id', 'position_id',
    'mint', 'symbol', 'name', 'status', 'executable', 'censored', 'unsellable', 'entry_timestamp_utc', 'exit_timestamp_utc', 'hold_ms', 'signal_age_ms',
    'source_wallets', 'source_signatures', 'distinct_wallets', 'cluster_adjusted_weight', 'brain_evidence_grade', 'brain_action', 'brain_control_action', 'tp1_posterior_mean', 'security_result', 'security_reason',
    'momentum_pct', 'trajectory_label', 'entry_reason', 'classification', 'fill_quality', 'sizing_mode', 'target_usd', 'submitted_sol', 'sol_usd',
    'input_lamports', 'token_amount_atomic', 'entry_expected_token_atomic', 'entry_conservative_token_atomic', 'entry_modelled_token_atomic',
    'expected_exit_proceeds_lamports', 'conservative_exit_proceeds_lamports', 'exit_modelled_proceeds_lamports', 'exit_proceeds_lamports',
    'network_fees_lamports', 'priority_fees_lamports', 'rent_fees_lamports', 'recoverable_rent_lamports', 'fees_lamports', 'fee_evidence',
    'initial_stop_pct', 'stop_evidence', 'tp1_hit', 'tp1_fill_return_pct', 'runner_trail_pct', 'exit_reason', 'mfe_pct', 'mae_pct', 'hold_duration_ms',
    'gross_pnl_lamports', 'net_pnl_lamports', 'net_pnl_pct', 'stop_overshoot_pct', 'record_json'
  ],
  'wallet-stats': ['schema_version', 'session_id', 'stats_id', 'timestamp_utc', 'wallet', 'unique_mints', 'tp1_successes', 'profitable_trades', 'tp1_posterior_mean', 'profitable_posterior_mean', 'record_json']
});

function csvEscape(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function utcDate(value = Date.now()) { return new Date(value).toISOString().slice(0, 10); }

class RefinedAuditWriter {
  constructor({ directory, clock = () => Date.now(), secrets = () => [] }) {
    this.directory = path.resolve(directory);
    this.clock = clock;
    this.secrets = secrets;
    this.known = new Set();
    this.counts = { events: 0, trades: 0, 'wallet-stats': 0 };
    this.lastWriteAt = null;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  _path(kind, date) {
    if (!HEADERS[kind]) throw new Error(`Unknown refined audit kind: ${kind}`);
    const headerLine = HEADERS[kind].join(',');
    const base = path.join(this.directory, `${kind}-${date}.csv`);
    if (!fs.existsSync(base) || fs.statSync(base).size === 0) return base;
    const firstLine = fs.readFileSync(base, 'utf8').split(/\r?\n/, 1)[0];
    if (firstLine === headerLine) return base;
    // Schema drift: this date's file already has a header from an earlier code version with a
    // different column set (HEADERS.trades has grown over time). Appending current-schema rows
    // under a stale header silently misaligns every field after the first divergent column, so
    // route to a versioned file for the current schema instead - the old file stays archived
    // on disk untouched, nothing is deleted or rewritten.
    for (let version = 2; ; version += 1) {
      const versioned = path.join(this.directory, `${kind}-${date}.v${version}.csv`);
      if (!fs.existsSync(versioned) || fs.statSync(versioned).size === 0) return versioned;
      if (fs.readFileSync(versioned, 'utf8').split(/\r?\n/, 1)[0] === headerLine) return versioned;
    }
  }

  _redact(value) {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    for (const secret of this.secrets().filter(Boolean)) text = text.replaceAll(String(secret), '[REDACTED]');
    text = text.replace(/(?:private[_-]?key|secret|x-api-key|api[_-]?key)\s*[:=]\s*["']?[^\s,"';}]+/gi, 'secret=[REDACTED]');
    return text;
  }

  _append(kind, id, timestamp, record) {
    if (!id) throw new Error(`${kind} audit row requires an id.`);
    const identity = `${kind}:${id}`;
    if (this.known.has(identity)) return { written: false, duplicate: true };
    const filePath = this._path(kind, utcDate(timestamp));
    const headers = HEADERS[kind];
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) fs.appendFileSync(filePath, `${headers.join(',')}\r\n`, 'utf8');
    const row = { schema_version: SCHEMA_VERSION, ...record };
    fs.appendFileSync(filePath, `${headers.map((header) => csvEscape(this._redact(row[header]))).join(',')}\r\n`, 'utf8');
    this.known.add(identity);
    this.counts[kind] += 1;
    this.lastWriteAt = this.clock();
    return { written: true, filePath };
  }

  writeEvent(record) { return this._append('events', record.event_id, record.timestamp_utc, record); }
  writeTrade(record) { return this._append('trades', record.trade_id, record.exit_timestamp_utc || record.entry_timestamp_utc, record); }
  writeWalletStats(record) { return this._append('wallet-stats', record.stats_id, record.timestamp_utc, record); }

  read(kind, date = utcDate(this.clock())) {
    const mapped = kind === 'walletStats' ? 'wallet-stats' : kind;
    const filePath = this._path(mapped, date);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : `${HEADERS[mapped].join(',')}\r\n`;
  }

  status() {
    return { schemaVersion: SCHEMA_VERSION, directory: this.directory, counts: { ...this.counts }, lastWriteAt: this.lastWriteAt, families: Object.keys(HEADERS) };
  }
}

module.exports = { HEADERS, RefinedAuditWriter, SCHEMA_VERSION, csvEscape };
