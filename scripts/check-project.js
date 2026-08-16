'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const errors = [];

if (manifest.manifest_version !== 3) errors.push('Extension must use Manifest V3.');
if (!manifest.permissions.includes('storage')) errors.push('Storage permission is missing.');
if (manifest.permissions.some((permission) => ['tabs', 'cookies', 'webRequest'].includes(permission))) {
  errors.push('Extension requests an unnecessary broad permission.');
}
if (manifest.host_permissions.some((pattern) => pattern === '<all_urls>' || pattern.includes('*://*'))) {
  errors.push('Extension has a broad host permission.');
}
if (config.bind !== '127.0.0.1') errors.push('Local service must bind to 127.0.0.1.');
if (config.bot.paperAggressive?.strategyVersion !== 'PAPER_AGGRESSIVE_BAYES_V1') errors.push('Bayesian paper strategy version is missing.');
if (config.bot.paperAggressive?.controlStrategyVersion !== 'PAPER_AGGRESSIVE_CONTROL') errors.push('Frozen paper control strategy is missing.');
if (config.tradeSizeUsd !== 14 || config.useFixedTradeSizeSol !== false) errors.push('Dynamic $14 sizing must be the default.');
if (config.bot.autoStart !== true || config.bot.paperAggressive?.maxOpenPositions !== 5) errors.push('Final aggressive AUTO defaults are invalid.');
if (config.bot.paperAggressive?.priceWaitTimeoutSeconds !== 10 || config.bot.paperAggressive?.priceRetryMs !== 1000) errors.push('Fresh-signal route-wait defaults are invalid.');
if (config.paper.platformFeeBps !== 100) errors.push('Initial GMGN paper platform fee must be 100 bps.');
if (config.bot.brain?.priorEquivalentSampleSize !== 20) errors.push('Bayesian prior equivalent sample size must default to 20.');
if (config.jupiter?.paperExecutionHaircutBps !== 0) errors.push('Initial Jupiter paper execution haircut must be logged as zero.');
if (config.bot.refined?.strategyVersion !== 'FLOWDECK_FINAL_V1' || config.bot.refined?.stopModelVersion !== 'DYNAMIC_STOP_V1') errors.push('Final strategy or stop-model version is missing.');
if (config.bot.refined?.executionDelayMinMs !== 250 || config.bot.refined?.executionDelayMaxMs !== 2000) errors.push('Final execution-delay bounds are invalid.');
if (config.bot.refined?.minStopPct !== 8 || config.bot.refined?.maxStopPct !== 30 || config.bot.refined?.fallbackStopPct !== 12) errors.push('Final dynamic-stop bounds are invalid.');
if (config.gmgn?.enabled !== true || config.gmgn?.discoveryEnabled !== false || config.gmgn?.maxQueueSize > 100) errors.push('Read-only bounded GMGN research defaults are invalid.');
if (config.gmgn?.maxCacheEntries > 200 || config.jupiter?.maxCacheEntries > 500) errors.push('Provider caches must remain explicitly bounded.');
if (config.rpc?.processedCommitment !== 'processed' || !(config.rpc?.quarantineMinimumSamples >= 3)) errors.push('Fresh processed-signal or wallet-quarantine defaults are missing.');
if (config.live?.enabled !== false || config.live?.signerConfigured !== false) errors.push('BOT_LIVE must remain locked for this task.');

for (const script of manifest.content_scripts.flatMap((entry) => entry.js).concat(manifest.background.service_worker)) {
  if (!fs.existsSync(path.join(root, 'extension', script))) errors.push(`Missing extension file: ${script}`);
}
for (const file of ['options.html', 'options.css', 'options.js']) if (!fs.existsSync(path.join(root, 'extension', file))) errors.push(`Missing extension file: ${file}`);

const productionRuntime = [
  fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'src', 'jupiter-client.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'extension', 'options.html'), 'utf8'),
  fs.readFileSync(path.join(root, 'extension', 'options.js'), 'utf8')
].join('\n');
if (/\/execute(?:\?|["'`/])/i.test(productionRuntime)) errors.push('Production paper runtime contains a Jupiter execute path.');
if (/privateKey|private key input|seed phrase input/i.test(productionRuntime)) errors.push('Production paper runtime requests or handles private-key material.');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
if (/GmgnExecutionAdapter|CredentialVault/.test(serverSource)) errors.push('Paper server imports a live or credential adapter.');
if (/\b(?:SurvivorshipPaperEngine|AutoBotEngine|PaperEngine)\b/.test(serverSource)) errors.push('Production server must instantiate only the authoritative final engine.');
if (!/GmgnResearchProvider/.test(serverSource) || !/state-final\.json/.test(serverSource)) errors.push('Final GMGN provider or state schema wiring is missing.');
const engineSource = fs.readFileSync(path.join(root, 'src', 'refined-engine.js'), 'utf8');
if (!/LIVE_BROADCAST_LOCKED_FOR_THIS_RELEASE_TASK/.test(engineSource)) errors.push('BOT_LIVE broadcast lock is missing.');
const gmgnSource = fs.readFileSync(path.join(root, 'src', 'gmgn-market-provider.js'), 'utf8');
if (/\b(?:swap|buy|sell|cook|launch)\b/i.test(gmgnSource.replace(/quoteReverse|reverseRouteAvailable/g, ''))) errors.push('GMGN research provider contains a write or trading command.');
const auditSource = fs.readFileSync(path.join(root, 'src', 'refined-audit.js'), 'utf8');
if (!/events-/.test(auditSource) && !/`\$\{kind\}-\$\{date\}\.csv`/.test(auditSource)) errors.push('Final daily audit families are missing.');
if (/counterfactual|universe/i.test(fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8'))) errors.push('Front-facing overlay must not restore research/universe dashboards.');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const overlayIds = [...contentSource.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
const overlayReferences = [...contentSource.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
const missingOverlayIds = [...new Set(overlayReferences.filter((id) => !overlayIds.includes(id)))];
if (missingOverlayIds.length) errors.push(`Overlay references missing element IDs: ${missingOverlayIds.join(', ')}`);
if (!/setInterval\(\(\) => void poll\(\), 500\)/.test(contentSource)) errors.push('Overlay polling must remain at the 2 Hz ceiling.');

const generatedWallets = JSON.parse(fs.readFileSync(path.join(root, 'data', 'wallets.generated.json'), 'utf8'));
if (!Array.isArray(generatedWallets.wallets) || generatedWallets.wallets.length > 100) errors.push('Generated candidate wallet roster is invalid.');
if (generatedWallets.wallets.some((wallet) => wallet.finalWeight < 0.5 || wallet.finalWeight > 2)) errors.push('Generated wallet weight is outside 0.5–2.0.');

const gmgnHosts = new Set(manifest.host_permissions);
if (!gmgnHosts.has('https://gmgn.ai/*') || !gmgnHosts.has('https://*.gmgn.ai/*')) {
  errors.push('Explicit GMGN host permissions are missing.');
}

const isolatedEntry = manifest.content_scripts.find((entry) => entry.js.includes('content.js'));
if (!isolatedEntry || isolatedEntry.run_at !== 'document_idle' || isolatedEntry.world !== 'ISOLATED') {
  errors.push('The UI content script must mount at document_idle in the isolated world.');
}
if (!manifest.permissions.includes('scripting') || !manifest.permissions.includes('activeTab')) {
  errors.push('Click-to-inject recovery permissions are missing.');
}

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(full) : entry.name.endsWith('.js') ? [full] : [];
  });
}

for (const file of javascriptFiles(root)) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) errors.push(`${path.relative(root, file)}: ${check.stderr.trim()}`);
}

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('FlowDeck static checks passed.\n');
}
