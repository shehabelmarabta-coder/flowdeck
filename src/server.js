'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { loadConfig } = require('./default-config');
const { GmgnResearchProvider } = require('./gmgn-market-provider');
const { JupiterOrderClient } = require('./jupiter-client');
const { DexScreenerPriceProvider } = require('./price-provider');
const { RefinedAuditWriter } = require('./refined-audit');
const { RefinedPaperEngine } = require('./refined-engine');
const { JsonStore } = require('./store');
const { TrajectoryIndex } = require('./trajectory');
const { SolanaWalletMonitor } = require('./wallet-monitor');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function json(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  response.end(body);
}

function text(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true'
  });
  response.end(body);
}

function allowedOrigin(origin) {
  if (!origin) return true;
  return origin.startsWith('chrome-extension://')
    || origin.startsWith('http://127.0.0.1')
    || origin.startsWith('http://localhost');
}

function createTokenDecimalsResolver({ config, fetchImpl = globalThis.fetch }) {
  const cache = new Map();
  let requestId = 1;
  return async (mint) => {
    if (cache.has(mint)) return cache.get(mint);
    const response = await fetchImpl(config.rpc.httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'getTokenSupply', params: [mint, { commitment: config.rpc.confirmationCommitment }] })
    });
    if (!response.ok) throw new Error(`Token-decimals RPC HTTP ${response.status}`);
    const payload = await response.json();
    const decimals = Number(payload.result?.value?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`Token decimals unavailable for ${mint}.`);
    cache.set(mint, decimals);
    return decimals;
  };
}

function createOnChainTokenMetadataResolver({ config, fetchImpl = globalThis.fetch }) {
  const cache = new Map();
  let requestId = 5_000;
  return async (mint) => {
    if (cache.has(mint)) return cache.get(mint);
    const response = await fetchImpl(config.rpc.httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'getAsset', params: { id: mint } })
    });
    if (!response.ok) throw new Error(`Token-metadata RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`Token metadata unavailable: ${payload.error.message || payload.error.code || 'RPC error'}`);
    const metadata = payload.result?.content?.metadata || {};
    const value = { name: metadata.name || '', symbol: metadata.symbol || '' };
    cache.set(mint, value);
    return value;
  };
}

function createPaperSimulator({ config, fetchImpl = globalThis.fetch }) {
  let requestId = 10_000;
  return async ({ transaction }) => {
    if (!transaction) return { classification: 'PAPER_STATE_ONLY', reason: 'NO_TRANSACTION' };
    try {
      const response = await fetchImpl(config.rpc.httpUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'simulateTransaction', params: [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: config.rpc.processedCommitment }] })
      });
      if (!response.ok) return { classification: 'UNAVAILABLE', reason: `SIMULATION_RPC_HTTP_${response.status}` };
      const payload = await response.json();
      const value = payload.result?.value;
      if (!payload.error && value && value.err == null) return { classification: 'ACCEPTABLE', unitsConsumed: value.unitsConsumed ?? null, logs: Array.isArray(value.logs) ? value.logs.slice(-10) : [] };
      const serialized = JSON.stringify({ error: payload.error || value?.err || payload, logs: value?.logs || [] }).slice(0, 2000);
      if (/(AccountNotFound|InvalidAccountForFee|insufficient funds|could not find account|account does not exist|no record of a prior credit|associated token account)/i.test(serialized)) {
        return { classification: 'PAPER_STATE_ONLY', reason: serialized };
      }
      return { classification: 'DETERMINISTIC_ERROR', reason: serialized };
    } catch (error) {
      return { classification: 'UNAVAILABLE', reason: String(error.message || error).slice(0, 300) };
    }
  };
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

async function command(engine, body, services = {}) {
  switch (body.action) {
    case 'set-auto':
      return engine.setAutoRun ? engine.setAutoRun(body.enabled) : { status: 'ignored', reason: 'auto-bot-unavailable' };
    case 'set-mode': {
      if (!engine.setMode) return { status: 'ignored', reason: 'auto-bot-unavailable' };
      const mode = String(body.mode || '');
      return engine.setMode(mode);
    }
    case 'check-live':
      return engine.checkLiveReadiness ? engine.checkLiveReadiness() : { status: 'blocked', reason: 'LIVE_LOCKED' };
    case 'reconcile':
      return engine.reconcile ? engine.reconcile() : { status: 'ignored', reason: 'auto-bot-unavailable' };
    case 'set-follow':
      return engine.setFollow(body.enabled);
    case 'buy':
      if (services.finalPaperEngine) return { status: 'blocked', reason: 'Final entries require an enabled-wallet signal plus fresh Jupiter entry and reverse quotes.' };
      return engine.manualBuy({ mint: body.mint, amountSol: body.amountSol, symbol: body.symbol });
    case 'sell':
      if (services.finalPaperEngine) return { status: 'blocked', reason: 'Final exits require a fresh amount-specific Jupiter reverse quote.' };
      return engine.manualSell({ mint: body.mint, percent: body.percent });
    case 'set-risk':
      return engine.setRisk(body);
    case 'set-limit':
      return engine.setLimit(body);
    case 'cancel-limit':
      return engine.cancelLimit(body.mint);
    case 'reset':
      return engine.reset();
    default:
      return { status: 'ignored', reason: 'unknown-command' };
  }
}

function createHttpServer({ engine, config, services = {} }) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-private-network': 'true',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET, POST, OPTIONS'
        });
        response.end();
        return;
      }
      if (!allowedOrigin(request.headers.origin)) {
        json(response, 403, { ok: false, error: 'Only the local extension may control this server.' });
        return;
      }
      const url = new URL(request.url, `http://${config.bind}:${config.port}`);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const snapshot = engine.snapshot();
        json(response, 200, { ok: true, mode: snapshot.mode || 'BOT_PAPER', autoRun: Boolean(snapshot.autoRun), strategy: snapshot.strategy, candidateWalletCount: snapshot.candidateWalletCount || config.wallets.length, serverTime: Date.now() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        json(response, 200, engine.snapshot(url.searchParams.get('mint') || ''));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/export.csv') {
        text(response, 200, engine.exportClosedTradesCsv(), 'text/csv; charset=utf-8');
        return;
      }
      const auditMatch = request.method === 'GET' && url.pathname.match(/^\/api\/audit\/(events|trades|wallet-stats)\.csv$/);
      if (auditMatch) {
        if (!services.auditWriter) throw Object.assign(new Error('Paper audit unavailable'), { statusCode: 503 });
        text(response, 200, services.auditWriter.read(auditMatch[1], url.searchParams.get('date') || undefined), 'text/csv; charset=utf-8');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/market') {
        const body = await readJson(request);
        const lifecycle = String(body.lifecycleStage || '').toUpperCase();
        let result;
        if (engine.observeDiscovery && ['NEAR_COMPLETION', 'MIGRATED'].includes(lifecycle)) {
          engine.observeDiscovery({ ...body, status: lifecycle === 'MIGRATED' ? 'MIGRATED' : 'PRE-ARMED' });
          result = { status: 'accepted', market: engine.markets.get(body.mint) || null };
        } else result = engine.setMarket(body);
        json(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/followed-wallets') {
        const body = await readJson(request);
        const result = engine.setFollowedWallets(Array.isArray(body.wallets) ? body.wallets : []);
        if (result.status === 'updated' && services.dataDirectory) {
          try {
            fs.mkdirSync(services.dataDirectory, { recursive: true });
            fs.writeFileSync(path.join(services.dataDirectory, 'wallets.followed.json'), JSON.stringify({ wallets: config.wallets, updatedAt: Date.now() }, null, 2));
          } catch { /* in-memory roster still applies for this session even if the persist write fails */ }
        }
        json(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/signal') {
        const body = await readJson(request);
        if (services.finalPaperEngine && body.source !== 'solana-rpc') {
          json(response, 403, { status: 'filtered', reason: 'Qualifying wallet signals come only from fetched and decoded Solana RPC transactions.' });
          return;
        }
        const result = engine.handleWalletSignal ? await engine.handleWalletSignal(body) : await engine.handleSignal(body);
        json(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/credentials') {
        json(response, 410, { ok: false, error: 'Credential input is disabled. FlowDeck never accepts a private key in this task.' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/command') {
        const result = await command(engine, await readJson(request), services);
        json(response, 200, result);
        return;
      }
      json(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      json(response, error.statusCode || 500, { ok: false, error: error.message || 'Internal error' });
    }
  });
}

async function startServer(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const testRuntime = Boolean(process.env.NODE_TEST_CONTEXT);
  const loaded = options.config
    ? { config: options.config, configPath: '(in-memory)' }
    : loadConfig(projectRoot);
  const config = loaded.config;
  const dataDirectory = options.dataDirectory
    || process.env.FLOWDECK_DATA_DIR
    || path.join(projectRoot, 'data');
  const store = options.store === undefined ? new JsonStore(dataDirectory, { stateFilename: 'state-final.json', eventsFilename: null }) : options.store;
  let disposableAuditDirectory = null;
  const auditDirectory = options.auditDirectory || (testRuntime
    ? (disposableAuditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-audit-test-')))
    : path.join(dataDirectory, 'audit'));
  const auditWriter = options.auditWriter === undefined ? new RefinedAuditWriter({
    directory: auditDirectory,
    secrets: () => [process.env.JUPITER_API_KEY, process.env.GMGN_API_KEY]
  }) : options.auditWriter;
  const trajectoryIndex = options.trajectoryIndex || TrajectoryIndex.load(path.join(projectRoot, 'data', 'trajectory.index.json'));
  const decimalsResolver = options.decimalsResolver || createTokenDecimalsResolver({ config, fetchImpl: options.fetchImpl });
  const metadataResolver = options.metadataResolver || createOnChainTokenMetadataResolver({ config, fetchImpl: options.fetchImpl });
  if (!config.jupiter.paperTakerAddress) {
    config.jupiter.paperTakerAddress = config.wallets.find((wallet) => wallet.enabled !== false)?.address || '';
  }
  const jupiterClient = options.jupiterClient === undefined
    ? (testRuntime ? null : new JupiterOrderClient({ config, fetchImpl: options.fetchImpl, decimalsResolver }))
    : options.jupiterClient;
  const simulator = options.simulator === undefined ? (testRuntime ? null : createPaperSimulator({ config, fetchImpl: options.fetchImpl })) : options.simulator;
  let engine = options.engine || null;
  const gmgnMarketProvider = options.gmgnMarketProvider === undefined
    ? (testRuntime ? null : new GmgnResearchProvider({
        config,
        onChainResolver: metadataResolver,
        onStatus: (status) => engine?.setServiceStatus?.(status)
      }))
    : options.gmgnMarketProvider;
  engine ||= new RefinedPaperEngine({ config, store, trajectoryIndex, auditWriter, jupiterClient, simulator, researchProvider: gmgnMarketProvider });
  engine.setExecutionServices?.({ jupiterClient, simulator });
  engine.setResearchProvider?.(gmgnMarketProvider);
  const monitor = options.monitor || new SolanaWalletMonitor({
    config,
    cursorStore: store,
    fetchImpl: options.fetchImpl,
    onSignal: (signal) => engine.handleWalletSignal ? engine.handleWalletSignal(signal) : engine.handleSignal(signal),
    onStatus: (status) => engine.setServiceStatus(status),
    onEvidence: (evidence) => engine.recordObservation?.(evidence)
  });
  const priceProvider = options.priceProvider || new DexScreenerPriceProvider({ config, engine });
  const services = { auditWriter, finalPaperEngine: engine instanceof RefinedPaperEngine, jupiterClient, gmgnMarketProvider, dataDirectory };
  const server = createHttpServer({ engine, config, services });
  const listenPort = options.port ?? config.port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, config.bind, resolve);
  });
  monitor.start();
  priceProvider.start();
  gmgnMarketProvider?.start?.();
  engine.startAutomation?.();
  server.once('close', () => {
    monitor.stop();
    priceProvider.stop();
    gmgnMarketProvider?.stop?.();
    engine.stopAutomation?.();
    if (disposableAuditDirectory) fs.rmSync(disposableAuditDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  return {
    server,
    engine,
    monitor,
    priceProvider,
    gmgnMarketProvider,
    auditWriter,
    jupiterClient,
    config,
    configPath: loaded.configPath,
    url: `http://${config.bind}:${address.port}`
  };
}

if (require.main === module) {
  startServer()
    .then(({ server, config, configPath }) => {
      process.stdout.write(`FlowDeck v3.1: http://${config.bind}:${server.address().port}\n`);
      process.stdout.write(`Startup: BOT_PAPER + ${config.bot.autoStart ? 'AUTO' : 'PAUSED'} | Config: ${configPath}\n`);
      const stop = () => server.close(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error) => {
      process.stderr.write(`FlowDeck failed to start: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { allowedOrigin, command, createHttpServer, createOnChainTokenMetadataResolver, createPaperSimulator, createTokenDecimalsResolver, startServer };
