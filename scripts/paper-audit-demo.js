'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CsvAuditWriter } = require('../src/audit-writer');
const { AutoBotEngine } = require('../src/bot-engine');
const { normalizeConfig } = require('../src/default-config');
const { TrajectoryIndex } = require('../src/trajectory');
const { startServer } = require('../src/server');

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '3SkBCx49BsK64h6tssBBJZ1WNvpiLdnhnXNmJtP46d7b';

async function request(url, pathname, body) {
  const response = await fetch(`${url}${pathname}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${await response.text()}`);
  return response.headers.get('content-type')?.includes('text/csv') ? response.text() : response.json();
}

async function waitFor(test, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await test();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function runDemo() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdeck-paper-demo-'));
  let app;
  try {
    let now = Date.parse('2026-08-14T12:00:00.000Z');
    const config = normalizeConfig({
      bind: '127.0.0.1', wallets: [{ address: WALLET, enabled: true, weight: 1 }],
      paper: { latencyMs: 0, detectionToDecisionMs: 0, maxPriceAgeMs: 60_000 },
      priceFallback: { enabled: false }, gmgn: { discoveryEnabled: false }
    });
    const auditWriter = new CsvAuditWriter({ directory, clock: () => now, secrets: () => ['demo-api-secret'] });
    const engine = new AutoBotEngine({ config, store: null, clock: () => now, trajectoryIndex: new TrajectoryIndex(), auditWriter, sessionId: 'localhost-demo-session' });
    const idle = { start() {}, stop() {} };
    app = await startServer({ config, store: null, engine, auditWriter, monitor: idle, priceProvider: idle, gmgnMarketProvider: idle, port: 0 });

    await request(app.url, '/api/command', { action: 'set-auto', enabled: true });
    const waiting = await request(app.url, '/api/signal', { mint: MINT, wallet: WALLET, side: 'buy', signature: 'localhost-demo-buy', lifecycleStage: 'NEW_CREATION' });
    if (waiting.status !== 'awaiting-price') throw new Error(`Expected price wait, received ${waiting.status}`);
    await request(app.url, '/api/market', { mint: MINT, symbol: 'DEMO', priceUsd: 1, source: 'gmgn-network', observedAt: now });
    const position = await waitFor(async () => {
      const snapshot = await request(app.url, `/api/snapshot?mint=${MINT}`);
      return snapshot.botPosition || null;
    }, 'Paper entry did not fill through localhost API.');
    now += 5_000;
    await engine.auditTick();
    await request(app.url, '/api/market', { mint: MINT, symbol: 'DEMO', priceUsd: position.entryIndex * 1.16, source: 'gmgn-network', observedAt: now });
    await waitFor(async () => (await request(app.url, `/api/snapshot?mint=${MINT}`)).botPosition?.stage === 'AFTER_TP1', 'TP1 did not fill.');
    now += 1_000;
    await request(app.url, '/api/market', { mint: MINT, symbol: 'DEMO', priceUsd: position.entryIndex * 1.51, source: 'gmgn-network', observedAt: now });
    await waitFor(async () => !(await request(app.url, `/api/snapshot?mint=${MINT}`)).botPosition, 'Final exit did not fill.');

    const events = await request(app.url, '/api/audit/events.csv');
    const trades = await request(app.url, '/api/audit/trades.csv');
    const eventLines = events.trimEnd().split(/\r?\n/);
    const tradeLines = trades.trimEnd().split(/\r?\n/);
    process.stdout.write(`LOCALHOST=${app.url}\n`);
    process.stdout.write(`EVENT_HEADER=${eventLines[0]}\n`);
    process.stdout.write(`EVENT_ROW=${eventLines.find((line) => line.includes(',PAPER_BUY,')) || eventLines[1]}\n`);
    process.stdout.write(`TRADE_HEADER=${tradeLines[0]}\n`);
    process.stdout.write(`TRADE_ROW=${tradeLines[1]}\n`);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    const resolved = path.resolve(directory);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (require.main === module) runDemo().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = { runDemo };
