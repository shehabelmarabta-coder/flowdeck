# FlowDeck

FlowDeck is a local Solana tracked-wallet bot with one authoritative decision, order, accounting, and audit pipeline. `BOT_PAPER` is enabled by default. `BOT_LIVE` uses the same pipeline boundary but remains explicitly locked and cannot broadcast during this task.

```text
processed wallet notification -> decoded fresh swap -> candidate -> GMGN filter
-> Bayesian/trajectory decision -> frozen intent -> exact Jupiter entry + reverse route
-> simulation classification -> measured delay -> exact revalidation -> paper fill
-> position -> TP1 / dynamic stop / runner trail -> closed trade
```

Backfilled transactions are evidence only. Signals older than 10 seconds, signals received while AUTO is paused, and candidates that expire while waiting for a route cannot execute later.

## Start

Requires Node.js 22 or newer and `gmgn-cli` configured for read-only research.

```powershell
cd C:\Users\sheha\Desktop\flowdeck
gmgn-cli config --check
npm test
npm run check
npm run smoke
npm start
```

The local API binds to `http://127.0.0.1:17333`. Load `extension` as an unpacked Chrome extension, open or refresh a GMGN tab, and use the FlowDeck panel. AUTO starts in `BOT_PAPER`; pausing it immediately expires pending candidates.

## Execution And Sizing

The default entry target is `$14`. A fresh exact Jupiter SOL/USDC quote determines the submitted lamports for every decision. `useFixedTradeSizeSol` is an explicit fallback switch and is off by default.

Every paper entry requires an exact-sized Jupiter route and an exact-quantity reverse route. The engine builds an unsigned transaction when Jupiter and the configured public taker support it, simulates where technically valid, waits the measured 250-2,000 ms build delay, and revalidates before filling. It never calls a Jupiter execute endpoint.

Evidence classes are exact:

- `SIMULATED_BUILDABLE`
- `BUILDABLE_UNSIMULATED`
- `QUOTE_PARITY`
- `NO_FILL`

No executable route means no paper fill. Reference prices and GMGN candles can inform momentum or trajectory evidence but never enter primary P&L.

## Research And Risk

The read-only GMGN provider runs only `config --check`, `token info`, `token security`, `token pool`, and `market kline`. Results are summarized, cached for five minutes, coalesced by mint, and passed through deterministic blacklist/security filtering. Incomplete evidence can be `EXPERIMENTAL` in paper mode and is blocked for live decisions.

Wallet evidence uses unique-mint Beta-binomial shrinkage. One fresh enabled wallet can trigger paper evaluation; distinct fresh wallets strengthen the candidate with correlation-adjusted weight.

`DYNAMIC_STOP_V1` calculates:

```text
noisePct = max(2 * robustSigmaPct, shrunk winner MAE)
rawStopPct = round-trip frictionPct + noisePct
stopPct = clamp(rawStopPct, 8%, 20%)
```

When coin-specific volatility and winner-MAE evidence are insufficient, the position is explicitly labelled `FALLBACK - INSUFFICIENT COIN EVIDENCE` and uses 12%. A raw stop wider than 20% is rejected. Stops never widen.

At +15% net executable return, FlowDeck sells exactly 50% of the remaining atomic token quantity and allocates entry basis and fees pro rata. The runner uses `clamp(1.5 * robustSigmaPct + frictionPct, 6%, 15%)`, protects at least break-even after TP1, and exits after a 30-minute total hold. Pre-TP1 positions exit after 10 minutes.

## Accounting And Audit

All amounts use integer atomic strings and `BigInt` arithmetic:

```text
cash = starting cash - entry spends + conservative sell proceeds - execution costs
equity = cash + current conservative reverse-route liquidation value
realized P&L = disposed proceeds - allocated basis - allocated costs
unrealized P&L = liquidation proceeds - remaining basis - estimated exit costs
```

`CLOSE ALL + NEW SESSION` pauses entries, prioritizes exact reverse routes, waits at most 20 seconds, records any unresolved balance as `UNSELLABLE_CLOSED` with zero recoverable proceeds, finalizes session statistics, and starts a clean paused session without deleting audit history.

Only these append-only daily files are created in `data\audit`:

- `events-YYYY-MM-DD.csv`
- `trades-YYYY-MM-DD.csv`
- `wallet-stats-YYYY-MM-DD.csv`

Runtime state is schema-versioned in `data\state-final.json`. The overlay polls at no more than 2 Hz and keeps provider queues, rate limits, decode failures, quarantined wallet sources, and memory inside the collapsed technical-health section.
