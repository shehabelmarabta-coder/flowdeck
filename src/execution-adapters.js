'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { decimalToAtomic, percentOf } = require('./atomic');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unwrap(payload) {
  let value = payload;
  for (let index = 0; index < 3; index += 1) {
    if (value && typeof value === 'object' && value.data != null) value = value.data;
    else break;
  }
  return value;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('GMGN CLI returned no JSON.');
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  throw new Error('GMGN CLI returned an unreadable response.');
}

function confirmedOrder(payload) {
  const data = unwrap(payload) || {};
  const status = String(data.status || '').toLowerCase();
  const reportStatus = String(data.report?.status || '').toLowerCase();
  return status === 'confirmed' || (Number(data.state) === 30 && reportStatus === 'successful');
}

function executionDetails(value) {
  const report = value?.report || {};
  const outputDecimals = Number(report.output_token_decimals);
  const inputDecimals = Number(report.input_token_decimals);
  return {
    transactionId: value?.hash || null,
    executionPriceUsd: Number(report.price_usd || 0) || null,
    proceedsSol: report.output_token === SOL_MINT && Number.isFinite(outputDecimals) ? Number(report.output_amount || 0) / 10 ** outputDecimals : null,
    spentSol: report.input_token === SOL_MINT && Number.isFinite(inputDecimals) ? Number(report.input_amount || 0) / 10 ** inputDecimals : null,
    feesSol: Number(report.gas_native || 0) || null
  };
}

class PaperExecutionAdapter {
  constructor({ engine, config, waitImpl = wait }) {
    this.engine = engine;
    this.config = config;
    this.wait = waitImpl;
    this.mode = 'BOT_PAPER';
  }

  async quote({ mint, side = 'buy', amountSol = 0, percent = 100 }) {
    const market = this.engine._freshMarket(mint);
    const usableIndex = Number(market?.priceUsd) > 0 || Number(market?.marketCapUsd) > 0;
    if (!market || !usableIndex) return { ok: false, routeable: false, reason: 'no-fresh-paper-price-or-index' };
    const proxyOnly = !(Number(market.priceUsd) > 0) && Number(market.marketCapUsd) > 0;
    return {
      ok: true,
      routeable: !proxyOnly,
      mint,
      side,
      amountSol,
      percent,
      priceUsd: market.priceUsd,
      indexValue: proxyOnly ? market.marketCapUsd : market.priceUsd,
      pricingUnit: proxyOnly ? 'MARKET_CAP_RATIO' : market.priceSol ? 'SOL' : 'USD_RATIO',
      fillQuality: proxyOnly ? 'PROXY_ONLY' : 'EXECUTABLE_PRICE',
      observedAt: market.receivedAt,
      quoteFeeSol: Number(market.quoteFeeSol || 0),
      source: market.quoteSource || market.source || 'paper-market'
    };
  }

  async buy({ mint, amountSol, symbol = '', decision = {} }) {
    if (this.config.paper.latencyMs > 0) await this.wait(this.config.paper.latencyMs);
    const result = this.engine._buy({
      mint,
      amountSol,
      symbol,
      reason: 'auto-entry',
      sourceSignalId: decision.id || '',
      sourceObservedAt: decision.signalObservedAt || null,
      sourceReceivedAt: decision.decidedAt || null,
      additionalFeeSol: Number(decision.quote?.quoteFeeSol || 0)
    });
    return { ...result, confirmed: result.status === 'filled', transactionId: result.fill?.id || null, executionPriceUsd: result.fill?.executionPriceUsd || null };
  }

  async sellPercent({ mint, percent, reason, decision = {} }) {
    if (this.config.paper.latencyMs > 0) await this.wait(this.config.paper.latencyMs);
    const lots = this.engine.state.lots.filter((lot) => lot.mint === mint);
    const result = this.engine._sellLots({ mint, lots, fraction: Number(percent) / 100, reason, additionalFeeSol: Number(decision.quote?.quoteFeeSol || 0) });
    return { ...result, confirmed: result.status === 'filled', transactionId: result.fill?.id || null, executionPriceUsd: result.fill?.executionPriceUsd || null };
  }

  async orderStatus(orderId) {
    const fill = this.engine.state.fills.find((item) => item.id === orderId);
    return { confirmed: Boolean(fill), status: fill ? 'confirmed' : 'unknown', transactionId: fill?.id || null };
  }

  async reconcilePositions() {
    return { confirmed: true, positions: this.engine.snapshot().positions };
  }
}

class JupiterPaperExecutionAdapter {
  constructor({ engine, config, jupiterClient }) {
    this.engine = engine; this.config = config; this.client = jupiterClient; this.mode = 'BOT_PAPER';
  }

  async quote({ mint, side = 'buy', amountSol = 0, percent = 100, purpose = '' }) {
    if (side === 'buy') {
      const inputLamports = decimalToAtomic(String(amountSol || this.config.bot.paperAggressive.orderSol), 9).toString();
      const assessment = await this.client.prepareEntry({ outputMint: mint, inputLamports });
      return {
        ok: assessment.ok, routeable: assessment.ok, mint, side, amountSol, assessment,
        priceQuality: assessment.entry?.priceQuality || null, reason: assessment.outcome,
        observedAt: assessment.entry?.receivedAt || Date.now(), source: 'jupiter-order-v2'
      };
    }
    const lot = this.engine.state.lots.find((item) => item.mint === mint && item.source === 'jupiter-paper');
    if (!lot) return { ok: false, routeable: false, reason: 'no-jupiter-position' };
    const tokenAmountAtomic = percentOf(lot.remainingTokenAmountAtomic, percent).toString();
    const reverse = await this.client.quoteReverse({ mint, tokenAmountAtomic, purpose: purpose || 'POSITION_EXIT' });
    return { ...reverse, routeable: Boolean(reverse.ok), mint, side, percent, tokenAmountAtomic, source: 'jupiter-order-v2' };
  }

  async buy({ mint, symbol = '', decision = {} }) {
    const result = this.engine._buyJupiterAssessment({ mint, symbol, assessment: decision.quote?.assessment, decision });
    return { ...result, confirmed: result.status === 'filled', transactionId: result.fill?.id || null };
  }

  async sellPercent({ mint, percent, reason, decision = {} }) {
    const result = this.engine._sellJupiterQuote({ mint, percent, reason, quote: decision.quote, decision });
    return { ...result, confirmed: result.status === 'filled', transactionId: result.fill?.id || null };
  }

  async orderStatus(orderId) {
    const fill = this.engine.state.fills.find((item) => item.id === orderId);
    return { confirmed: Boolean(fill), status: fill ? 'confirmed' : 'unknown', transactionId: fill?.id || null };
  }

  async reconcilePositions() { return { confirmed: true, positions: this.engine.snapshot().positions }; }
  status() { return this.client.status(); }
}

class GmgnProcessRunner {
  constructor({ command = 'gmgn-cli', spawnImpl = spawn, timeoutMs = 15_000 }) {
    const resolved = resolveCliCommand(command);
    this.command = resolved.command;
    this.prefixArgs = resolved.prefixArgs;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
  }

  run(args, { credentials = {}, trade = false, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, [...this.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GMGN_API_KEY: credentials.apiKey || '',
          GMGN_PRIVATE_KEY: credentials.privateKeyPem || '',
          ...(trade ? { GMGN_ALLOW_AUTOMATED_TRADES: '1' } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
      child.stderr?.on('data', (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          let detail = String(stderr || stdout).trim().slice(0, 500);
          for (const secret of [credentials.apiKey, credentials.privateKeyPem]) if (secret) detail = detail.replaceAll(secret, '[REDACTED]');
          reject(new Error(`GMGN CLI exited ${code}: ${detail}`));
        }
        else resolve({ stdout, stderr, code });
      });
    });
  }
}

function resolveCliCommand(command) {
  const value = String(command || 'gmgn-cli');
  if (value.endsWith('.js') && fs.existsSync(value)) return { command: process.execPath, prefixArgs: [path.resolve(value)] };
  if (process.platform !== 'win32') return { command: value, prefixArgs: [] };
  const shimDirectory = value.toLowerCase().endsWith('.cmd') || value.toLowerCase().endsWith('.ps1') ? path.dirname(path.resolve(value)) : path.join(process.env.APPDATA || '', 'npm');
  const entry = path.join(shimDirectory, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  if (fs.existsSync(entry)) return { command: process.execPath, prefixArgs: [entry] };
  return { command: value, prefixArgs: [] };
}

class GmgnExecutionAdapter {
  constructor({ config, credentialVault, runner = null, waitImpl = wait }) {
    this.config = config;
    this.vault = credentialVault;
    this.runner = runner || new GmgnProcessRunner({ command: config.gmgn.cliPath, timeoutMs: config.gmgn.timeoutMs });
    this.wait = waitImpl;
    this.mode = 'BOT_LIVE';
  }

  credentials() {
    return this.vault.get();
  }

  async _json(args, options = {}) {
    const result = await this.runner.run([...args, '--raw'], { credentials: this.credentials(), ...options });
    return parseJsonOutput(result.stdout);
  }

  async quote({ mint, side = 'buy', amountSol = 0, percent = 100 }) {
    const credentials = this.credentials();
    let inputToken = SOL_MINT;
    let outputToken = mint;
    let amount = Math.max(1, Math.round(Number(amountSol || this.config.defaultOrderSol) * 1e9));
    if (side === 'sell') {
      inputToken = mint;
      outputToken = SOL_MINT;
      const reconciliation = await this.reconcilePositions();
      const position = reconciliation.positions.find((item) => item.mint === mint);
      amount = Math.floor(Number(position?.rawAmount || 0) * Number(percent) / 100);
      if (!(amount > 0)) return { ok: false, routeable: false, reason: 'no-linked-wallet-token-balance' };
    }
    try {
      const payload = unwrap(await this._json(['order', 'quote', '--chain', 'sol', '--from', credentials.fromWallet, '--input-token', inputToken, '--output-token', outputToken, '--amount', String(amount), '--slippage', String(this.config.gmgn.slippagePct)]));
      return { ok: Boolean(payload?.output_amount || payload?.outputAmount), routeable: Boolean(payload?.output_amount || payload?.outputAmount), ...payload, quoteFeeSol: Number(payload?.fee_native || payload?.gas_native || payload?.fee || 0) || 0, observedAt: Date.now(), source: 'gmgn-cli' };
    } catch (error) {
      return { ok: false, routeable: false, reason: error.message };
    }
  }

  async _confirm(payload) {
    let value = unwrap(payload) || {};
    if (confirmedOrder(value)) return { confirmed: true, ...value, ...executionDetails(value) };
    const orderId = value.order_id || value.orderId;
    if (!orderId || ['failed', 'expired'].includes(String(value.status).toLowerCase())) return { confirmed: false, uncertain: false, ...value };
    for (let attempt = 0; attempt < this.config.gmgn.orderPollAttempts; attempt += 1) {
      await this.wait(this.config.gmgn.orderPollMs);
      value = unwrap(await this._json(['order', 'get', '--chain', 'sol', '--order-id', String(orderId)])) || {};
      if (confirmedOrder(value)) return { confirmed: true, ...value, ...executionDetails(value) };
      if (['failed', 'expired'].includes(String(value.status).toLowerCase())) return { confirmed: false, uncertain: false, ...value };
    }
    return { confirmed: false, uncertain: true, orderId, status: value.status || 'unknown' };
  }

  async buy({ mint, amountSol }) {
    const credentials = this.credentials();
    const payload = await this._json([
      'swap', '--chain', 'sol', '--from', credentials.fromWallet, '--input-token', SOL_MINT, '--output-token', mint,
      '--amount', String(Math.max(1, Math.round(Number(amountSol) * 1e9))), '--slippage', String(this.config.gmgn.slippagePct),
      '--priority-fee', String(this.config.paper.priorityFeeSol), '--anti-mev', '--yes'
    ], { trade: true, timeoutMs: this.config.gmgn.tradeTimeoutMs });
    return this._confirm(payload);
  }

  async sellPercent({ mint, percent }) {
    const credentials = this.credentials();
    const payload = await this._json([
      'swap', '--chain', 'sol', '--from', credentials.fromWallet, '--input-token', mint, '--output-token', SOL_MINT,
      '--percent', String(percent), '--slippage', String(this.config.gmgn.slippagePct), '--priority-fee', String(this.config.paper.priorityFeeSol),
      '--anti-mev', '--yes'
    ], { trade: true, timeoutMs: this.config.gmgn.tradeTimeoutMs });
    return this._confirm(payload);
  }

  async orderStatus(orderId) {
    const value = unwrap(await this._json(['order', 'get', '--chain', 'sol', '--order-id', String(orderId)]));
    return { ...value, confirmed: confirmedOrder(value), transactionId: value?.hash || null };
  }

  async reconcilePositions() {
    const credentials = this.credentials();
    const value = unwrap(await this._json(['portfolio', 'holdings', '--chain', 'sol', '--wallet', credentials.fromWallet, '--limit', '50', '--show-small']));
    const list = Array.isArray(value) ? value : value?.list || value?.holdings || [];
    return {
      confirmed: true,
      positions: list.map((item) => ({
        mint: item.token_address || item.address || item.mint,
        rawAmount: Number(item.raw_amount || item.balance_raw || item.amount || 0),
        balance: Number(item.balance || item.amount_cur || 0),
        usdValue: Number(item.usd_value || 0)
      }))
    };
  }

  async readiness({ quoteMint = USDC_MINT } = {}) {
    const status = this.vault.status();
    const result = { ready: false, cli: false, current: false, authenticated: false, linkedWalletVisible: false, swapAccess: false, quote: false, checkedAt: Date.now(), reason: null };
    if (!status.complete) return { ...result, reason: 'GMGN credentials are incomplete.' };
    try {
      const version = await this.runner.run(['--version'], { credentials: this.credentials() });
      result.cli = true;
      result.version = String(version.stdout || '').trim();
      result.current = true;
      const info = unwrap(await this._json(['portfolio', 'info']));
      const serialized = JSON.stringify(info || {});
      result.linkedWalletVisible = serialized.includes(this.credentials().fromWallet);
      if (!result.linkedWalletVisible) throw new Error('Linked wallet is not visible to this GMGN API key.');
      await this._json(['track', 'follow-wallet', '--chain', 'sol', '--wallet', this.credentials().fromWallet, '--limit', '1']);
      result.authenticated = true;
      const quote = await this.quote({ mint: quoteMint, side: 'buy', amountSol: 0.001 });
      result.quote = quote.ok;
      result.swapAccess = quote.ok;
      result.ready = result.cli && result.current && result.authenticated && result.linkedWalletVisible && result.swapAccess && result.quote;
      result.reason = result.ready ? null : quote.reason || 'GMGN quote or swap/IP access check failed.';
    } catch (error) {
      result.reason = error.message;
    }
    return result;
  }
}

module.exports = { GmgnExecutionAdapter, GmgnProcessRunner, JupiterPaperExecutionAdapter, PaperExecutionAdapter, SOL_MINT, USDC_MINT, confirmedOrder, parseJsonOutput, resolveCliCommand, unwrap };
