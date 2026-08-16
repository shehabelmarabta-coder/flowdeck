(function installFlowDeckContent() {
  'use strict';

  if (document.getElementById('flowdeck-private-root')) return;
  const shared = globalThis.FlowDeckShared;
  const messaging = globalThis.FlowDeckRuntime;
  if (!shared || !messaging) return;

  const PAGE_SOURCE = 'flowdeck-page-v1';
  const state = {
    currentMint: shared.extractMintFromUrl(location.href), snapshot: null, connected: false,
    minimized: false, contextInvalidated: false, lastMarketKey: '', lastMarketSentAt: 0, commandBusy: false,
    tab: 'trading', todaySort: { key: 'exitAt', direction: -1 }
  };
  let pollTimer = null;
  let routeTimer = null;
  let toastTimer = null;
  let attachObserver = null;

  function api(path, options = {}) {
    return messaging.send({ type: 'flowdeck-api', path, method: options.method || 'GET', body: options.body, responseType: options.responseType }, { onInvalidated: invalidateContext });
  }

  const host = document.createElement('div');
  host.id = 'flowdeck-private-root';
  host.style.cssText = 'position:fixed;left:clamp(8px,4vw,72px);top:clamp(8px,8vh,76px);z-index:2147483647;width:min(410px,calc(100vw - 16px));color-scheme:dark';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial}*{box-sizing:border-box;letter-spacing:0}button,input{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}
      .panel{--good:#51ddb1;--info:#65bee8;--bad:#ff708d;--muted:#87949b;width:100%;overflow:hidden;border:1px solid #394348;border-radius:8px;background:#101416;color:#edf2f3;box-shadow:0 20px 55px #0009;font:600 11px/1.4 Inter,system-ui,sans-serif}
      .head{height:46px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#1a2124;border-bottom:1px solid #374146;cursor:grab;user-select:none}.logo{width:27px;height:27px;border-radius:6px;display:grid;place-items:center;background:#58d4bd;color:#10211e;font-size:15px;font-weight:1000}.brand{font-size:14px;font-weight:950}.spacer{margin-left:auto}.icon{width:28px;height:28px;border:1px solid #465258;border-radius:6px;background:#222b2f}.body{max-height:calc(100vh - 100px);overflow:auto;padding:8px 10px 10px}.min .body{display:none}
      .statusbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 7px;margin-bottom:7px;border:1px solid #2b3438;border-radius:6px;background:#151b1d;font-size:8px;color:var(--muted)}
      .modebadge{padding:2px 6px;border:1px solid #397565;border-radius:4px;color:#9fead3;font-size:8px;font-weight:900}
      .run{padding:4px 8px;border:1px solid #5b313b;border-radius:5px;background:#2c1d21;color:#ffb1c0;font-weight:950;font-size:8px}.run.on{border-color:#34745f;background:#17362e;color:#b9f8e4}
      .dot{width:7px;height:7px;border-radius:50%;background:var(--bad);display:inline-block;margin-right:3px}.dot.on{background:var(--good);box-shadow:0 0 8px #51ddb188}.dot.warn{background:#e8c065}
      .statusbar .sep{opacity:.5}
      .tabs{display:flex;gap:4px;margin-bottom:7px}.tab{flex:1;padding:6px;border:1px solid #2b3438;border-radius:5px;background:#151b1d;color:#87949b;font-size:9px;font-weight:900}.tab.active{background:#1c2528;color:#edf2f3;border-color:#44616c}
      .notice{padding:6px 7px;margin-bottom:7px;border-left:3px solid #506069;background:#171d20;color:#9ba7ac;font-size:8px}
      .card{padding:9px 1px;border:0;border-bottom:1px solid #2b3438;border-radius:0;background:transparent;margin:0}.eyebrow{color:#7dc7e7;font-size:8px;margin-bottom:6px;font-weight:900}summary.eyebrow{cursor:pointer;user-select:none}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.grid.five{grid-template-columns:repeat(5,minmax(0,1fr))}.grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}.metric{min-width:0;padding:6px 3px;border-radius:5px;background:#1a2124;text-align:center}.metric small{display:block;color:#89969c;font-size:7px;white-space:normal}.metric strong{display:block;margin-top:2px;font-size:9px;overflow-wrap:anywhere}.good{color:var(--good)!important}.bad{color:var(--bad)!important}.blue{color:var(--info)!important}
      .token{display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:900}.token span:first-child{overflow-wrap:anywhere}.mono{font:500 8px ui-monospace,monospace;color:#8b989e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mintline{display:flex;align-items:center;gap:5px}.copy{width:23px;height:21px;border:1px solid #465258;border-radius:4px;background:#222b2f;font-size:12px}.reason{margin-top:6px;padding-top:6px;border-top:1px solid #283135;color:#aab3b7;font-size:8px}.row{padding:6px 0;border-bottom:1px solid #252e32}.row:last-child{border:0}.rowtop{display:flex;justify-content:space-between;gap:8px}.row b{font-size:9px;overflow-wrap:anywhere}.sub{color:#87949b;font-size:8px;margin-top:2px;overflow-wrap:anywhere}.line{display:grid;grid-template-columns:130px minmax(0,1fr);gap:7px;padding:4px 0;border-bottom:1px solid #252e32;font-size:8px}.line:last-child{border:0}.line span:first-child{color:#7f8d93}.line span:last-child{color:#c0c8cb;overflow-wrap:anywhere}.scroll{max-height:260px;overflow:auto}.empty{padding:10px 0;color:#78868c;text-align:center;font-size:9px}
      .hero{border:1px solid #2b3438;border-radius:7px;padding:10px;background:#141a1c}
      .hero .pnlbig{font-size:26px;font-weight:950;line-height:1.1;margin:4px 0}
      .hero .sub{margin-top:2px}
      .armbadge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:7px;font-weight:900;margin-left:5px}.armbadge.pending{background:#3a2d17;color:#e8c065}.armbadge.armed{background:#17362e;color:#b9f8e4}
      .emptyhero{padding:16px 4px;text-align:center;color:#78868c}
      .rejectlist .row{padding:4px 0}
      table.today{width:100%;border-collapse:collapse;font-size:8px;margin-top:6px}table.today th{text-align:left;color:#7dc7e7;font-weight:900;padding:4px 3px;border-bottom:1px solid #2b3438;cursor:pointer;user-select:none}table.today td{padding:4px 3px;border-bottom:1px solid #202a2d;overflow-wrap:anywhere}
      .performance{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.performance .line{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.performance .line span:last-child{text-align:right}.reset{width:100%;margin-top:7px;padding:8px;border:1px solid #8b3a55;border-radius:6px;background:#391725;color:#ffadc1;font-size:9px;font-weight:900}.audit{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:6px}.audit button{padding:6px 2px;border:1px solid #44616c;border-radius:5px;background:#202b30;font-size:7px}.date{width:100%;padding:5px;border:1px solid #465258;border-radius:5px;background:#171d20;color:#c1cbcf;font-size:9px}.footer{display:flex;justify-content:space-between;gap:8px;color:#75838a;font-size:7px;margin-top:8px}.toast{position:absolute;left:10px;right:10px;top:49px;z-index:4;padding:8px;border:1px solid #497483;border-radius:6px;background:#203036;opacity:0;transform:translateY(-5px);transition:.15s;pointer-events:none}.toast.show{opacity:1;transform:none}.toast.bad{border-color:#863a57;background:#3a1827}
    </style>
    <div class="panel" id="panel">
      <div class="head" id="drag"><div class="logo">F</div><div class="brand">FlowDeck</div><div class="spacer"></div><button class="icon" data-action="settings" title="Settings">&#9881;</button><button class="icon" data-action="minimize" title="Minimize">&minus;</button></div>
      <div class="toast" id="toast"></div>
      <div class="body">
        <div class="statusbar">
          <span class="modebadge" id="modeBadge">BOT_PAPER</span>
          <button class="run" id="run" data-action="run">AUTO PAUSED</button>
          <span id="uptime">&mdash;</span><span class="sep">&middot;</span>
          <span id="walletsLine">0/0 wallets</span><span class="sep">&middot;</span>
          <span><span class="dot" id="jupiterDot"></span>J</span>
          <span><span class="dot" id="gmgnDot"></span>G</span><span class="sep">&middot;</span>
          <span id="queueLine">q0</span>
        </div>
        <div class="notice">LIVE-READY DECISION PIPELINE &middot; BROADCAST LOCKED</div>
        <div class="tabs">
          <button class="tab active" data-tab-select="trading">TRADING</button>
          <button class="tab" data-tab-select="diagnostics">DIAGNOSTICS</button>
        </div>
        <div id="tradingView">
          <div class="hero" id="positionHero"></div>
          <details class="card" id="todaySection">
            <summary class="eyebrow">TODAY</summary>
            <div class="grid four" id="todaySummary"></div>
            <table class="today" id="todayTable"><thead><tr><th data-sort="symbol">SYMBOL</th><th data-sort="holdMs">HOLD</th><th data-sort="exitReason">EXIT</th><th data-sort="netPnlPct">NET %</th></tr></thead><tbody id="todayBody"></tbody></table>
          </details>
        </div>
        <div id="diagnosticsView" style="display:none">
          <div class="card"><div class="eyebrow">BOT PERFORMANCE &middot; THIS SESSION</div><div class="performance" id="performance"></div></div>
          <div class="card"><div class="eyebrow">RECENT ACTIVITY</div><div class="scroll" id="activity"></div></div>
          <div class="card">
            <div class="eyebrow">TECHNICAL HEALTH</div>
            <div class="line"><span>RPC / QUEUE</span><span id="rpcHealth">&mdash;</span></div><div class="line"><span>JUPITER / GMGN</span><span id="providers">&mdash;</span></div><div class="line"><span>FILL EVIDENCE</span><span id="quality">0 / 0 / 0 / 0</span></div><div class="line"><span>REVALIDATION / FEES</span><span id="technicalCoverage">0% / 0%</span></div><div class="line"><span>MEMORY</span><span id="memory">&mdash;</span></div><div class="line"><span>AUDIT</span><span id="auditState">events / trades / wallet-stats</span></div>
            <input class="date" id="auditDate" type="date"><div class="audit"><button data-audit="events">EVENTS</button><button data-audit="trades">TRADES</button><button data-audit="wallet-stats">WALLET STATS</button></div>
            <button class="reset" data-action="reset">RESET SESSION</button>
          </div>
        </div>
        <div class="footer"><span id="walletCount">0 wallets</span><span>PRIMARY P&amp;L EXCLUDES REFERENCE PRICES</span></div>
      </div>
    </div>`;

  const $ = (id) => root.getElementById(id);
  const panel = $('panel');
  const fmtPct = (value) => `${Number(value || 0).toFixed(1)}%`;
  const fmtMs = (value) => Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : '—';
  const fmtSol = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(6)} SOL` : '—';
  const fmtUsd = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}$${Math.abs(Number(value)).toFixed(2)}`.replace('+$', '$') : '—';
  const fmtDuration = (milliseconds) => {
    const total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
    return `${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m`;
  };
  const shortMint = (value) => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';
  const tone = (value) => Number(value) > 0 ? 'good' : Number(value) < 0 ? 'bad' : '';

  function toast(message, bad = false) {
    const node = $('toast'); node.textContent = message; node.classList.toggle('bad', bad); node.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function invalidateContext() {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true; state.connected = false; clearInterval(pollTimer); clearInterval(routeTimer); attachObserver?.disconnect();
    root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    $('run').disabled = false; $('run').dataset.action = 'refresh-page'; $('run').textContent = 'REFRESH GMGN TAB';
    $('walletsLine').textContent = 'EXTENSION UPDATED · REFRESH TAB';
    toast('Extension updated. Refresh this GMGN tab to reconnect.', true);
  }

  function row(title, value, detail = '', valueClass = '') {
    const node = document.createElement('div'); node.className = 'row';
    const top = document.createElement('div'); top.className = 'rowtop';
    const left = document.createElement('b'); left.textContent = title; const right = document.createElement('b'); right.textContent = value; if (valueClass) right.className = valueClass;
    top.append(left, right); node.append(top);
    if (detail) { const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = detail; node.append(sub); }
    return node;
  }

  function performanceLine(title, value, valueClass = '') {
    const node = document.createElement('div'); node.className = 'line';
    const label = document.createElement('span'); label.textContent = title;
    const result = document.createElement('span'); result.textContent = value; if (valueClass) result.className = valueClass;
    node.append(label, result); return node;
  }

  function copyButton(mint) {
    const copy = document.createElement('button'); copy.className = 'copy'; copy.dataset.copy = mint || ''; copy.title = 'Copy mint'; copy.innerHTML = '&#9112;';
    return copy;
  }

  // Zone 2 hero: the open position is the whole screen when one exists; otherwise a flat
  // one-line state plus the last three rejects, per the trading-surface-only redesign.
  function renderHero(snapshot) {
    const hero = $('positionHero'); hero.replaceChildren();
    const position = snapshot?.positions?.[0];
    if (!position) {
      const empty = document.createElement('div'); empty.className = 'emptyhero';
      const line = document.createElement('div'); line.textContent = 'No open position'; line.style.fontWeight = '900';
      empty.append(line);
      const rejects = (snapshot?.recentCandidates || []).filter((item) => ['REJECTED', 'EXPIRED', 'AVOID'].includes(item.status)).slice(0, 3);
      const list = document.createElement('div'); list.className = 'rejectlist';
      if (rejects.length) {
        for (const candidate of rejects) list.append(row(candidate.symbol || shortMint(candidate.mint), candidate.status, candidate.reason || '—'));
      } else {
        const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = 'No recent rejects.'; list.append(sub);
      }
      empty.append(list); hero.append(empty);
      return;
    }
    const heading = document.createElement('div'); heading.className = 'token';
    const identity = document.createElement('span'); identity.textContent = `${position.symbol || 'Unknown token'} · ${fmtDuration(position.holdMs)} old`;
    heading.append(identity);
    const mintLine = document.createElement('div'); mintLine.className = 'mintline';
    const mint = document.createElement('span'); mint.className = 'mono'; mint.textContent = shortMint(position.mint);
    mintLine.append(mint, copyButton(position.mint));
    const pnl = document.createElement('div'); pnl.className = `pnlbig ${tone(position.currentNetPnlPct)}`;
    pnl.textContent = `${Number(position.currentNetPnlPct || 0) >= 0 ? '+' : ''}${Number(position.currentNetPnlPct || 0).toFixed(2)}%`;
    const notional = document.createElement('div'); notional.className = 'sub';
    notional.textContent = `In ${fmtUsd(position.entryAmountUsd)} (${position.entryAmountSol} SOL) · mark ${position.currentLiquidationSol} SOL (${fmtUsd(position.currentLiquidationUsd)})`;
    const stopLine = document.createElement('div'); stopLine.className = 'sub';
    const distanceToStop = Number(position.currentNetPnlPct || 0) - Number(position.stopPnlFloorPct || 0);
    const armed = position.stopArmingState === 'STOP_ARMED';
    stopLine.append(document.createTextNode(`Stop ${Number(position.stopPnlFloorPct || 0).toFixed(1)}% · ${distanceToStop.toFixed(1)}pp away`));
    const armBadge = document.createElement('span'); armBadge.className = `armbadge ${armed ? 'armed' : 'pending'}`;
    armBadge.textContent = armed ? 'STOP_ARMED' : `STOP_PENDING ${Math.ceil((position.stopArmingRemainingMs || 0) / 1000)}s`;
    stopLine.append(armBadge);
    const tp1Line = document.createElement('div'); tp1Line.className = 'sub';
    const distanceToTp1 = 15 - Number(position.currentNetPnlPct || 0);
    tp1Line.textContent = position.tp1?.hit
      ? `TP1 captured · trail ${Number(position.currentTrailPct || 0).toFixed(1)}% · floor ${Number(position.currentTrailFloorPct || 0).toFixed(1)}%`
      : `TP1 target +15% · ${distanceToTp1.toFixed(1)}pp away`;
    const mfeMaeLine = document.createElement('div'); mfeMaeLine.className = 'sub';
    mfeMaeLine.textContent = `MFE ${fmtPct(position.mfePct)} · MAE ${fmtPct(position.maePct)}`;
    const walletsLine = document.createElement('div'); walletsLine.className = 'sub';
    const wallets = (position.sourceWallets || []).map((item) => item.label || shortMint(item.address || item)).join(', ') || '—';
    walletsLine.textContent = `Triggered by ${wallets}`;
    hero.append(heading, mintLine, pnl, notional, stopLine, tp1Line, mfeMaeLine, walletsLine);
  }

  function renderToday(snapshot) {
    const trades = (snapshot?.recentClosedTrades || []).filter((trade) => isToday(trade.exitAt));
    const wins = trades.filter((trade) => Number(trade.netPnlLamports) > 0).length;
    const netSol = trades.reduce((sum, trade) => sum + Number(trade.netPnlLamports || 0), 0) / 1e9;
    const netPct = trades.length ? trades.reduce((sum, trade) => sum + Number(trade.netPnlPct || 0), 0) / trades.length : 0;
    const summary = $('todaySummary'); summary.replaceChildren();
    const cell = (label, value, valueClass = '') => {
      const node = document.createElement('div'); node.className = 'metric';
      const small = document.createElement('small'); small.textContent = label;
      const strong = document.createElement('strong'); strong.textContent = value; if (valueClass) strong.className = valueClass;
      node.append(small, strong); return node;
    };
    summary.append(
      cell('CLOSED', String(trades.length)), cell('WINS', `${wins} / ${trades.length}`),
      cell('NET P&L', `${netSol >= 0 ? '+' : ''}${netSol.toFixed(4)} SOL · ${fmtPct(netPct)}`, tone(netSol)),
      cell('RENT OUTSTANDING', `${Number(snapshot?.stats?.rentOutstandingSol || 0).toFixed(4)} SOL`)
    );
    const sorted = [...trades].sort((a, b) => {
      const { key, direction } = state.todaySort;
      const left = key === 'symbol' || key === 'exitReason' ? String(a[key] || '') : Number(a[key] || 0);
      const right = key === 'symbol' || key === 'exitReason' ? String(b[key] || '') : Number(b[key] || 0);
      if (left < right) return -1 * direction; if (left > right) return 1 * direction; return 0;
    });
    const body = $('todayBody'); body.replaceChildren();
    for (const trade of sorted) {
      const tr = document.createElement('tr');
      const cells = [trade.symbol || shortMint(trade.mint), fmtDuration(trade.holdMs), trade.exitReason || '—', `${Number(trade.netPnlPct || 0) >= 0 ? '+' : ''}${Number(trade.netPnlPct || 0).toFixed(2)}%`];
      cells.forEach((value, index) => { const td = document.createElement('td'); td.textContent = value; if (index === 3) td.className = tone(trade.netPnlPct); tr.append(td); });
      body.append(tr);
    }
    if (!sorted.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.className = 'empty'; td.textContent = 'No closes today'; tr.append(td); body.append(tr); }
  }

  function isToday(timestamp) {
    if (!timestamp) return false;
    const now = new Date(); const then = new Date(timestamp);
    return now.getUTCFullYear() === then.getUTCFullYear() && now.getUTCMonth() === then.getUTCMonth() && now.getUTCDate() === then.getUTCDate();
  }

  function render() {
    if (state.contextInvalidated) return;
    const snapshot = state.snapshot;
    const stats = snapshot?.stats || {};
    const rpcState = snapshot?.services?.rpc || 'unknown';
    const observation = snapshot?.services?.observationHealth || {};
    const visibleRpcState = observation.rpcBackoffMs > 0 ? 'backing-off' : rpcState;
    $('modeBadge').textContent = snapshot?.mode || 'BOT_PAPER';
    $('run').textContent = snapshot?.autoRun ? 'AUTO RUNNING' : 'AUTO PAUSED'; $('run').classList.toggle('on', Boolean(snapshot?.autoRun)); $('run').disabled = state.commandBusy;
    const uptimeMs = snapshot?.session?.startedAt ? Date.now() - Number(snapshot.session.startedAt) : 0;
    $('uptime').textContent = state.connected ? `up ${fmtDuration(uptimeMs)} · RPC ${String(visibleRpcState).toUpperCase()}` : 'LOCAL ENGINE OFFLINE';
    $('walletsLine').textContent = `${observation.activeSubscriptions || 0}/${observation.expectedWallets || snapshot?.candidateWalletCount || 0} wallets`;
    const jupiter = snapshot?.services?.jupiter || {}; const gmgn = snapshot?.services?.gmgn || {};
    $('jupiterDot').classList.toggle('on', Boolean(jupiter.available));
    $('gmgnDot').classList.toggle('on', gmgn.ready === true); $('gmgnDot').classList.toggle('warn', gmgn.enabled !== false && gmgn.ready !== true);
    $('queueLine').textContent = `q${observation.queueDepth || 0}/${observation.maxQueueSize || 0}`;

    renderHero(snapshot);
    renderToday(snapshot);

    const parity = snapshot?.parity || {}; const counts = parity.counts || {}; const qualities = parity.fillQualities || {};
    const performance = $('performance'); performance.replaceChildren();
    const sessionLines = [
      ['Signals', `${stats.signals || 0}`], ['Candidates', `${stats.candidates || 0} / ${stats.signals || 0}`],
      ['Paper fills', `${stats.paperFills || 0} / ${stats.candidates || 0}`], ['Open / closed', `${stats.openPositions || 0} / ${stats.closedTrades || 0}`],
      ['Wins / losses', `${stats.wins || 0} / ${stats.losses || 0}`], ['Win rate', `${stats.wins || 0} / ${stats.closedTrades || 0} · ${fmtPct(stats.winRatePct)}`],
      ['Gross profit / loss', `${fmtSol(stats.grossProfitSol)} / ${fmtSol(stats.grossLossSol)}`], ['Net P&L', `${fmtSol(stats.totalNetPnlSol)} · ${fmtUsd(stats.totalNetPnlUsd)}`],
      ['Return on capital', fmtPct(stats.returnOnDeployedCapitalPct)], ['Profit factor', stats.profitFactor == null ? '∞' : Number(stats.profitFactor || 0).toFixed(2)],
      ['Expectancy / trade', `${fmtSol(stats.expectancyPerTradeSol)} · ${fmtPct(stats.expectancyPerTradePct)}`], ['Median return', stats.medianTradeReturnPct == null ? '—' : fmtPct(stats.medianTradeReturnPct)],
      ['Best / worst', `${stats.bestTradeReturnPct == null ? '—' : fmtPct(stats.bestTradeReturnPct)} / ${stats.worstTradeReturnPct == null ? '—' : fmtPct(stats.worstTradeReturnPct)}`], ['Max drawdown', fmtSol(`-${stats.maximumDrawdownSol || 0}`)],
      ['Avg / median hold', `${fmtDuration(stats.averageHoldMs)} / ${fmtDuration(stats.medianHoldMs)}`], ['TP1 captures', `${stats.tp1Captures || 0} / ${stats.tp1Opportunities || 0}`],
      ['Stop overshoot', stats.averageStopOvershootPct == null ? '—' : fmtPct(stats.averageStopOvershootPct)], ['Exact routes', `${counts.exactRoutes || 0} / ${counts.routeAttempts || 0} · ${fmtPct(parity.exactRouteCoveragePct)}`],
      ['Buildable fills', `${(qualities.SIMULATED_BUILDABLE || 0) + (qualities.BUILDABLE_UNSIMULATED || 0)} / ${(qualities.SIMULATED_BUILDABLE || 0) + (qualities.BUILDABLE_UNSIMULATED || 0) + (qualities.QUOTE_PARITY || 0)} · ${fmtPct(parity.buildableFillRatePct)}`], ['Simulated fills', `${qualities.SIMULATED_BUILDABLE || 0} / ${(qualities.SIMULATED_BUILDABLE || 0) + (qualities.BUILDABLE_UNSIMULATED || 0) + (qualities.QUOTE_PARITY || 0)} · ${fmtPct(parity.simulationCoveragePct)}`],
      ['Reverse sell routes', `${counts.sellRoutes || 0} / ${counts.sellRouteAttempts || 0} · ${fmtPct(parity.sellRouteCoveragePct)}`], ['Rate limits', `${parity.providerRateLimitCount || stats.rateLimitCount || 0} / ${snapshot?.services?.jupiter?.requests || 0} · ${fmtPct(parity.providerRateLimitRatePct)}`],
      ['Signal → decision', `${fmtMs(parity.signalToDecisionP50Ms)} / ${fmtMs(parity.signalToDecisionP75Ms)} p50/p75`], ['Decision → fill', `${fmtMs(parity.decisionToFillP50Ms)} / ${fmtMs(parity.decisionToFillP75Ms)} p50/p75`],
      ['Stale signal drops', `${parity.staleSignalDrops || 0} / ${stats.signals || 0}`],
      ['Brain vs control', `A ${snapshot?.stats?.brainDivergence?.groupA?.count || 0} · B ${snapshot?.stats?.brainDivergence?.groupB?.count || 0}`]
    ];
    for (const [title, value] of sessionLines) performance.append(performanceLine(title, value));

    const activity = $('activity'); activity.replaceChildren();
    for (const event of (snapshot?.recentActivity || []).slice(0, 12)) {
      const sourceEvidence = event.type === 'SOURCE_EVIDENCE';
      const title = sourceEvidence ? String(event.status || event.type).replaceAll('_', ' ') : event.type.replaceAll('_', ' ');
      const value = sourceEvidence ? (event.reason || 'RECORDED') : (event.status || event.reason || 'RECORDED');
      const wallet = event.payload?.wallet ? shortMint(event.payload.wallet) : shortMint(event.mint);
      const aggregated = Number(event.payload?.aggregatedSincePrevious || 0);
      activity.append(row(title, value, `${new Date(event.timestamp).toLocaleTimeString()} · ${wallet}${aggregated ? ` · ${aggregated} similar grouped` : ''}`, /FAILED|NO_FILL|UNSELLABLE|REJECT/.test(`${event.type}:${event.status}`) ? 'bad' : /FILLED|OPENED|RESUMED/.test(event.type) ? 'good' : ''));
    }
    if (!activity.children.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No trading events yet'; activity.append(empty); }

    $('quality').textContent = `${qualities.SIMULATED_BUILDABLE || 0} simulated / ${qualities.BUILDABLE_UNSIMULATED || 0} buildable / ${qualities.QUOTE_PARITY || 0} quote / ${qualities.NO_FILL || 0} no-fill`;
    const quarantined = observation.quarantinedWallets?.length || 0;
    $('rpcHealth').textContent = `${visibleRpcState} · ${observation.activeSubscriptions || 0}/${observation.expectedWallets || 0} WSS · ${observation.queueDepth || 0}/${observation.maxQueueSize || 0} queued · ${observation.reconnectCount || 0} reconnects · ${observation.decodeFailures || 0} decode failures · ${quarantined} quarantined`;
    $('providers').textContent = `Jupiter ${jupiter.available ? 'ready' : 'offline'} q${jupiter.scheduler?.queueDepth || 0} / GMGN ${gmgn.enabled === false ? 'disabled' : gmgn.ready ? 'ready' : 'checking'} q${gmgn.scheduler?.queueDepth || 0} · ${Number(jupiter.rateLimited || 0) + Number(gmgn.rateLimited || 0)} rate limits`;
    $('technicalCoverage').textContent = `${fmtPct(parity.revalidationSuccessPct)} / ${fmtPct(parity.completeFeeCoveragePct)}`;
    $('memory').textContent = snapshot?.advanced?.memoryMb ? `${Number(snapshot.advanced.memoryMb).toFixed(1)} MB` : '—';
    const audit = snapshot?.advanced?.audit; $('auditState').textContent = audit ? `${audit.counts?.events || 0} events · ${audit.counts?.trades || 0} trades` : 'unavailable';
    $('walletCount').textContent = `${snapshot?.candidateWalletCount || 0} enabled wallets`;
  }

  async function poll() {
    if (state.contextInvalidated) return;
    const response = await api(`/api/snapshot${state.currentMint ? `?mint=${encodeURIComponent(state.currentMint)}` : ''}`);
    if (response.contextInvalidated) return;
    state.connected = Boolean(response.ok && response.data?.ok);
    if (state.connected) state.snapshot = response.data;
    render();
  }

  async function command(body, success = 'Updated') {
    state.commandBusy = true; render();
    const response = await api('/api/command', { method: 'POST', body });
    state.commandBusy = false;
    const failed = !response.ok || ['blocked', 'failed', 'ignored', 'skipped', 'mismatch'].includes(response.data?.status);
    toast(failed ? messaging.friendlyError(response, 'FlowDeck command failed') : (response.data?.reason || success), failed);
    if (!response.contextInvalidated) await poll();
    return response;
  }

  function publishMarket(input) {
    if (!input || !shared.isAddress(input.mint) || (!(Number(input.priceUsd) > 0) && !(Number(input.marketCapUsd) > 0))) return;
    const market = { mint: input.mint, symbol: String(input.symbol || '').slice(0, 24), priceUsd: Number(input.priceUsd) || null, priceSol: Number(input.priceSol) || null, marketCapUsd: Number(input.marketCapUsd) || null, liquidityUsd: Number(input.liquidityUsd) || null, bondingPct: Number(input.bondingPct) || null, lifecycleStage: input.lifecycleStage || null, migrated: Boolean(input.migrated), nearGraduation: Boolean(input.nearGraduation), volume: Number(input.volume || input.volume24h || 0), volumeUsd: Number(input.volumeUsd) || null, feesSol: Number(input.feesSol) || null, ageMinutes: Number(input.ageMinutes) || null, hasSocial: Boolean(input.hasSocial), socialViews: Number(input.socialViews) || null, socialComments: Number(input.socialComments) || null, socialLikes: Number(input.socialLikes) || null, socialReposts: Number(input.socialReposts) || null, socialRising: Boolean(input.socialRising), source: String(input.source || 'gmgn-page'), observedAt: Number(input.observedAt) || Date.now() };
    const key = `${market.mint}:${market.priceUsd || ''}:${market.marketCapUsd || ''}:${market.source}`;
    if (key !== state.lastMarketKey || Date.now() - state.lastMarketSentAt > 1000) { state.lastMarketKey = key; state.lastMarketSentAt = Date.now(); void api('/api/market', { method: 'POST', body: market }); }
  }

  function setMint(mint) { const next = shared.isAddress(mint) ? mint : ''; if (next !== state.currentMint) { state.currentMint = next; void poll(); } }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    if (event.data.type === 'READY' || event.data.type === 'NAVIGATE') setMint(event.data.payload?.mint || shared.extractMintFromUrl(event.data.payload?.url));
    else if (event.data.type === 'MARKET') publishMarket(event.data.payload);
    else if (event.data.type === 'WALLETS') publishFollowedWallets(event.data.payload);
  });

  function publishFollowedWallets(input) {
    const wallets = (input?.wallets || []).filter((address) => shared.isAddress(address));
    if (!wallets.length) return;
    void api('/api/followed-wallets', { method: 'POST', body: { wallets } });
  }

  async function downloadAudit(kind) {
    const date = $('auditDate').value || new Date().toISOString().slice(0, 10);
    const response = await api(`/api/audit/${kind}.csv?date=${encodeURIComponent(date)}`, { responseType: 'text' });
    if (!response.ok) return toast(messaging.friendlyError(response, 'Audit export failed'), true);
    const href = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = href; link.download = `${kind}-${date}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function setTab(tab) {
    state.tab = tab;
    root.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tabSelect === tab));
    $('tradingView').style.display = tab === 'trading' ? '' : 'none';
    $('diagnosticsView').style.display = tab === 'diagnostics' ? '' : 'none';
  }

  root.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('button[data-tab-select]');
    if (tabButton) { setTab(tabButton.dataset.tabSelect); return; }
    const sortHeader = event.target.closest('th[data-sort]');
    if (sortHeader) {
      const key = sortHeader.dataset.sort;
      state.todaySort = { key, direction: state.todaySort.key === key ? -state.todaySort.direction : 1 };
      renderToday(state.snapshot); return;
    }
    const button = event.target.closest('button[data-action],button[data-audit],button[data-copy]'); if (!button || button.disabled) return;
    if (button.dataset.copy) {
      const mint = button.dataset.copy;
      if (!mint) return toast('No mint to copy', true);
      try { await navigator.clipboard.writeText(mint); toast('Mint copied'); } catch { toast('Clipboard permission unavailable', true); }
      return;
    }
    if (button.dataset.action === 'refresh-page') return location.reload();
    if (button.dataset.action === 'minimize') { state.minimized = !state.minimized; panel.classList.toggle('min', state.minimized); button.textContent = state.minimized ? '+' : '−'; return; }
    if (button.dataset.action === 'settings') { const response = await messaging.send({ type: 'flowdeck-open-options' }, { onInvalidated: invalidateContext }); if (!response.ok) toast(messaging.friendlyError(response), true); return; }
    if (button.dataset.action === 'run') return command({ action: 'set-auto', enabled: !state.snapshot?.autoRun }, state.snapshot?.autoRun ? 'Automation paused' : 'Automation resumed');
    if (button.dataset.action === 'reset') { if (confirm('Reset session: close every routeable paper position and start a genuinely clean new session? Audit history is archived, not deleted.')) return command({ action: 'reset' }, 'Session reset - clean new session started'); return; }
    if (button.dataset.audit) return downloadAudit(button.dataset.audit);
  });

  let drag = null;
  $('drag').addEventListener('pointerdown', (event) => { if (event.target.closest('button')) return; const rect = host.getBoundingClientRect(); drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }; $('drag').setPointerCapture(event.pointerId); });
  $('drag').addEventListener('pointermove', (event) => { if (!drag) return; const width = host.getBoundingClientRect().width; host.style.left = `${Math.max(0, Math.min(innerWidth - width, drag.left + event.clientX - drag.x))}px`; host.style.top = `${Math.max(0, Math.min(innerHeight - 45, drag.top + event.clientY - drag.y))}px`; });
  $('drag').addEventListener('pointerup', () => { drag = null; });

  function attach() { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); }
  attach(); attachObserver = new MutationObserver(attach); attachObserver.observe(document.documentElement, { childList: true });
  $('auditDate').value = new Date().toISOString().slice(0, 10);
  pollTimer = setInterval(() => void poll(), 500);
  routeTimer = setInterval(() => setMint(shared.extractMintFromUrl(location.href)), 1000);
  void poll();
})();
