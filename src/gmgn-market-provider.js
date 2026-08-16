'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PriorityScheduler } = require('./provider-scheduler');
const { firstFilter, tokenIdentity } = require('./token-research');

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function pick(source, keys) {
  const result = {};
  for (const key of keys) if (source?.[key] !== undefined) result[key] = source[key];
  return result;
}

function unwrap(payload) {
  let value = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.data != null) value = value.data;
    else if (value && typeof value === 'object' && !Array.isArray(value) && value.result != null) value = value.result;
    else break;
  }
  return value;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw new Error('GMGN CLI returned non-JSON output.');
}

function redactError(value) {
  return String(value || '')
    .replace(/(?:private[_-]?key|secret|x-api-key|api[_-]?key)\s*[:=]\s*["']?[^\s,"';}]+/gi, 'secret=[REDACTED]')
    .slice(0, 300);
}

function resolveCliCommand(executable, args) {
  const requested = String(executable || 'gmgn-cli');
  if (process.platform !== 'win32') return { command: requested, args };
  const base = path.basename(requested).replace(/\.(?:cmd|ps1|exe)$/i, '');
  if (base.toLowerCase() !== 'gmgn-cli') return { command: requested, args };
  const searchDirectories = path.isAbsolute(requested)
    ? [path.dirname(requested)]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of searchDirectories) {
    const script = path.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'gmgn-cli', 'dist', 'index.js');
    if (fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  }
  return { command: requested, args };
}

function runCli(executable, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = resolveCliCommand(executable, args);
    const child = spawn(invocation.command, invocation.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (collection) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(Object.assign(new Error('GMGN CLI output exceeded the bounded response size.'), { code: 'GMGN_OUTPUT_LIMIT' })));
        return;
      }
      collection.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      const output = Buffer.concat(stdout).toString('utf8');
      const diagnostics = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(Object.assign(new Error(redactError(diagnostics || `GMGN CLI exited with code ${code}.`)), { code: 'GMGN_CLI_FAILED', exitCode: code }));
        return;
      }
      resolve({ stdout: output, suspiciousMetadata: /neutralized\s+\d+\s+suspicious metadata/i.test(diagnostics) });
    }));
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(Object.assign(new Error('GMGN CLI request timed out.'), { code: 'GMGN_TIMEOUT' })));
    }, timeoutMs);
    timer.unref?.();
  });
}

function summarizeInfo(payload) {
  const value = unwrap(payload) || {};
  return {
    ...pick(value, ['address', 'symbol', 'name', 'decimals', 'circulating_supply', 'total_supply', 'liquidity', 'holder_count', 'launchpad', 'launchpad_status', 'launchpad_progress', 'creation_timestamp', 'open_timestamp']),
    price: pick(value.price || {}, ['price', 'price_1m', 'price_5m', 'price_1h', 'volume_1m', 'volume_5m', 'volume_1h', 'buy_volume_5m', 'sell_volume_5m', 'buys_5m', 'sells_5m', 'swaps_5m', 'hot_level']),
    pool: pick(value.pool || {}, ['pool_address', 'exchange', 'liquidity', 'fee_ratio', 'creation_timestamp']),
    dev: pick(value.dev || {}, ['creator_address', 'creator_token_status', 'top_10_holder_rate', 'creator_open_count', 'cto_flag']),
    stat: pick(value.stat || {}, ['holder_count', 'top_10_holder_rate', 'dev_team_hold_rate', 'creator_hold_rate', 'top_rat_trader_percentage', 'top_bundler_trader_percentage', 'fresh_wallet_rate']),
    wallet_tags_stat: pick(value.wallet_tags_stat || {}, ['smart_wallets', 'renowned_wallets', 'sniper_wallets', 'rat_trader_wallets', 'bundler_wallets', 'fresh_wallets'])
  };
}

function summarizeSecurity(payload) {
  return pick(unwrap(payload) || {}, [
    'is_honeypot', 'open_source', 'owner_renounced', 'renounced_mint', 'renounced_freeze_account',
    'buy_tax', 'sell_tax', 'top_10_holder_rate', 'adjusted_top_10_holder_rate', 'dev_team_hold_rate',
    'creator_balance_rate', 'creator_token_status', 'suspected_insider_hold_rate', 'rug_ratio',
    'is_wash_trading', 'rat_trader_amount_rate', 'bundler_trader_amount_rate', 'sniper_count', 'burn_status'
  ]);
}

function summarizePool(payload) {
  return pick(unwrap(payload) || {}, ['address', 'base_address', 'quote_address', 'exchange', 'liquidity', 'base_reserve', 'quote_reserve', 'price', 'creation_timestamp']);
}

function summarizeCandles(payload) {
  const value = unwrap(payload);
  const list = Array.isArray(value) ? value : Array.isArray(value?.list) ? value.list : [];
  return list.slice(-120).map((candle) => pick(candle, ['time', 'open', 'close', 'high', 'low', 'volume']));
}

class GmgnResearchProvider {
  constructor({ config, clock = () => Date.now(), waitImpl, commandRunner = runCli, onChainResolver = async () => null, onStatus = () => {} } = {}) {
    this.config = config;
    this.clock = clock;
    this.commandRunner = commandRunner;
    this.onChainResolver = onChainResolver;
    this.onStatus = onStatus;
    this.cache = new Map();
    this.inflight = new Map();
    this.readyPromise = null;
    this.providerState = 'idle'; this.lastError = null;
    this.stopped = true;
    this.metrics = { requests: 0, successes: 0, failures: 0, rateLimited: 0, cacheHits: 0, suspiciousMetadata: 0, latenciesMs: [] };
    this.scheduler = new PriorityScheduler({
      name: 'gmgn-read-only', maxConcurrency: 4, maxQueueSize: config.gmgn.maxQueueSize,
      rateLimitCapacity: config.gmgn.rateLimitCapacity, requestsPerSecond: config.gmgn.requestsPerSecond,
      clock, waitImpl
    });
  }

  start() {
    this.stopped = false;
    if (!this.config.gmgn.enabled) { this.providerState = 'disabled'; this.onStatus({ gmgn: 'disabled' }); return; }
    this.providerState = 'checking';
    this.onStatus({ gmgn: 'checking' });
    void this._ensureReady().then(
      () => { this.providerState = 'ready'; this.lastError = null; this.onStatus({ gmgn: 'ready', gmgnError: null }); },
      (error) => { this.providerState = 'degraded'; this.lastError = redactError(error.message); this.onStatus({ gmgn: 'degraded', gmgnError: this.lastError }); }
    );
  }

  stop() { this.stopped = true; }

  async _ensureReady() {
    if (!this.config.gmgn.enabled) throw Object.assign(new Error('GMGN read-only research is disabled.'), { code: 'GMGN_DISABLED' });
    if (!this.readyPromise) {
      this.readyPromise = this.commandRunner(this.config.gmgn.cliPath, ['config', '--check'], { timeoutMs: this.config.gmgn.timeoutMs })
        .catch((error) => { this.readyPromise = null; throw error; });
    }
    return this.readyPromise;
  }

  async _command(args, key) {
    await this._ensureReady();
    const startedAt = this.clock();
    this.metrics.requests += 1;
    try {
      const result = await this.scheduler.submit(
        () => this.commandRunner(this.config.gmgn.cliPath, args, { timeoutMs: this.config.gmgn.timeoutMs }),
        { priority: 'normal' }
      );
      const latency = Math.max(0, this.clock() - startedAt);
      this.metrics.latenciesMs.push(latency); this.metrics.latenciesMs = this.metrics.latenciesMs.slice(-500);
      this.metrics.successes += 1;
      if (result.suspiciousMetadata) this.metrics.suspiciousMetadata += 1;
      return { value: parseJsonOutput(result.stdout), suspiciousMetadata: result.suspiciousMetadata, key };
    } catch (error) {
      this.metrics.failures += 1;
      if (/429|RATE_LIMIT/i.test(`${error.code || ''}:${error.message || ''}`)) this.metrics.rateLimited += 1;
      throw error;
    }
  }

  async inspectMint(mint, { fresh = false } = {}) {
    const address = String(mint || '').trim();
    if (!SOLANA_ADDRESS_RE.test(address)) throw Object.assign(new Error('Invalid Solana mint address.'), { code: 'INVALID_MINT' });
    const cached = this.cache.get(address);
    if (!fresh && cached && this.clock() - cached.cachedAt <= this.config.gmgn.cacheMs) {
      this.metrics.cacheHits += 1;
      return { ...cached.value, cached: true };
    }
    if (this.inflight.has(address)) return this.inflight.get(address);
    const request = this._inspect(address).finally(() => this.inflight.delete(address));
    this.inflight.set(address, request);
    return request;
  }

  async _inspect(mint) {
    const nowSeconds = Math.floor(this.clock() / 1000);
    const tasks = [
      this._command(['token', 'info', '--chain', 'sol', '--address', mint, '--raw'], 'info'),
      this._command(['token', 'security', '--chain', 'sol', '--address', mint, '--raw'], 'security'),
      this._command(['token', 'pool', '--chain', 'sol', '--address', mint, '--raw'], 'pool'),
      this._command(['market', 'kline', '--chain', 'sol', '--address', mint, '--resolution', '30s', '--from', String(nowSeconds - 300), '--to', String(nowSeconds), '--raw'], 'kline')
    ];
    const [infoResult, securityResult, poolResult, klineResult] = await Promise.allSettled(tasks);
    const info = infoResult.status === 'fulfilled' ? summarizeInfo(infoResult.value.value) : null;
    const security = securityResult.status === 'fulfilled' ? summarizeSecurity(securityResult.value.value) : null;
    const pool = poolResult.status === 'fulfilled' ? summarizePool(poolResult.value.value) : null;
    const candles = klineResult.status === 'fulfilled' ? summarizeCandles(klineResult.value.value) : [];
    const suspiciousMetadata = [infoResult, securityResult, poolResult, klineResult]
      .some((result) => result.status === 'fulfilled' && result.value.suspiciousMetadata);
    let onChain = null;
    if (!info?.name && !info?.symbol) {
      try { onChain = await this.onChainResolver(mint); } catch {}
    }
    const identity = tokenIdentity({ mint, gmgnInfo: info, onChain });
    const errors = [infoResult, securityResult, poolResult, klineResult]
      .filter((result) => result.status === 'rejected')
      .map((result) => redactError(result.reason?.code || result.reason?.message || 'GMGN_UNAVAILABLE'));
    const value = {
      mint, identity, info, security, pool, candles, suspiciousMetadata, unavailable: errors.length > 0,
      unavailableReasons: [...new Set(errors)].slice(0, 4), observedAt: this.clock()
    };
    value.filter = this.classify(value, { reverseRouteAvailable: true });
    const cutoff = this.clock() - this.config.gmgn.cacheMs;
    for (const [cachedMint, cached] of this.cache) if (cached.cachedAt < cutoff) this.cache.delete(cachedMint);
    while (this.cache.size >= this.config.gmgn.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(mint, { cachedAt: this.clock(), value });
    this.providerState = errors.length === tasks.length ? 'degraded' : errors.length ? 'partial' : 'ready';
    this.lastError = errors[0] || null;
    this.onStatus({ gmgn: this.providerState, gmgnError: this.lastError, gmgnLastAt: this.clock() });
    return value;
  }

  classify(research, { reverseRouteAvailable = false } = {}) {
    const result = firstFilter({
      identity: research?.identity, info: research?.info, security: research?.security,
      pool: research?.pool, reverseRouteAvailable
    });
    const flags = [...new Set([...(result.flags || []), ...(research?.suspiciousMetadata ? ['SUSPICIOUS_METADATA'] : [])])];
    if ((research?.unavailable || research?.suspiciousMetadata) && result.result !== 'REJECT') {
      return { ...result, result: 'NEEDS_DEEPER_RESEARCH', reason: flags[0] || 'INCOMPLETE_GMGN_EVIDENCE', flags };
    }
    return { ...result, flags };
  }

  getCached(mint) {
    const cached = this.cache.get(String(mint || ''));
    return cached ? { ...cached.value, ageMs: Math.max(0, this.clock() - cached.cachedAt) } : null;
  }

  status() {
    const sorted = [...this.metrics.latenciesMs].sort((a, b) => a - b);
    const at = (fraction) => sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : null;
    return {
      enabled: this.config.gmgn.enabled, state: this.providerState, ready: this.providerState === 'ready' || this.providerState === 'partial', lastError: this.lastError, cacheEntries: this.cache.size, cacheLimit: this.config.gmgn.maxCacheEntries,
      inflight: this.inflight.size, requests: this.metrics.requests, successes: this.metrics.successes,
      failures: this.metrics.failures, rateLimited: this.metrics.rateLimited, cacheHits: this.metrics.cacheHits,
      suspiciousMetadata: this.metrics.suspiciousMetadata, medianLatencyMs: at(0.5), p95LatencyMs: at(0.95),
      scheduler: this.scheduler.status()
    };
  }
}

module.exports = {
  GmgnResearchProvider, SOLANA_ADDRESS_RE, parseJsonOutput, resolveCliCommand, runCli,
  summarizeCandles, summarizeInfo, summarizePool, summarizeSecurity, unwrap
};
