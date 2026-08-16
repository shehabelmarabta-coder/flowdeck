# FlowDeck 0.3R traceability

## Root causes found

The folder does not contain `.git`, so comparison used the source tree, tests, preserved state, and audit artifacts rather than commit history.

Production previously instantiated `SurvivorshipPaperEngine`, which extends `AutoBotEngine`, which extends `PaperEngine`. Those layers concurrently maintained `state.lots`, `state.bot.positions`, and `state.v3` candidates/cohorts/outcomes. They also ran a 500 ms audit/research tick. The extension aborted a command after 10 seconds, so a resume request blocked behind the layered work appeared as “server timed out” even while the Node process was listening. The duplicated models also made open positions, fills, and UI counters capable of disagreeing.

0.3R removes every legacy engine import from `src/server.js`. The old modules remain unchanged for compatibility tests but are unreachable from production.

## Authoritative implementation

- `src/refined-engine.js`: one state schema, candidate/intent/fill/position lifecycle, deterministic exit mutex, session reset, derived UI counters, bounded queues.
- `src/jupiter-client.js`: exact atomic Swap V2 order requests, forced fresh revalidation, transient unsigned transaction, route/impact/min-output and fee evidence.
- `src/risk-model.js`: robust EWMA/MAD volatility, unique-mint regime MAE80 shrinkage, friction-aware dynamic stop, absolute risk limit, runner trail.
- `src/refined-audit.js`: only `events`, `trades`, and `wallet-stats` daily CSVs. A closed trade's JSON contains its entry/exit intents and fills.
- `src/server.js`: separate `state-v03r.json`, simulation-only RPC boundary, no signing/broadcast adapter, no universe/research provider.
- `extension/content.js`: trading-first 2 Hz overlay with Advanced evidence collapsed and immediate resume feedback.

## Execution equations

```text
initialMinOut = Jupiter otherAmountThreshold
             or floor(initialOut * (10_000 - slippageBps) / 10_000)

fill iff freshRevalidatedOut >= initialMinOut

entry paper cash delta = -(exactInputLamports + entryNetworkPriorityRentFees)
exit paper cash delta  = +(exactReverseOutLamports - exitNetworkPriorityRentFees)

netPnl = sum(grossExitProceeds)
       - entryInput
       - entryFees
       - exitFees
```

```text
frictionPct = 100 * (max(input - immediateReverseOut, 0) + entryFees + expectedExitFees) / input
sigmaPct = max(1.4826 * MAD(logReturns), clipped EWMA sigma(logReturns))
shrinkWeight = uniqueRegimeWinnerMints / (uniqueRegimeWinnerMints + 20)
shrunkWinnerMae = shrinkWeight * regimeWinnerMae80 + (1 - shrinkWeight) * globalWinnerMae80
rawStopDistancePct = frictionPct + max(2 * sigmaPct, shrunkWinnerMae)
runnerTrailPct = clamp(1.5 * sigmaPct + frictionPct, 6, 15)
```

Insufficient evidence produces the 12% stop fallback. Stops are bounded to 8–20%; raw values above 20% reject as `RISK_TOO_WIDE`. The fixed 0.01 SOL size is never resized. If its stop plus costs exceeds `maxLossSol`, the intent rejects as `MAX_LOSS_EXCEEDED`.

## Remaining paper/live differences

Paper never signs, submits, lands, or observes a validator-confirmed fill. `FULL_PARITY` covers buildability, simulation, revalidation, and complete quoted fee fields but still cannot reproduce leader scheduling, block contention, RPC propagation, account changes after revalidation, validator inclusion, or real wallet balances. `QUOTE_PARITY` is used when the exact route revalidates but paper-wallet state cannot be represented. These differences are reported as rates, not an accuracy or profit claim.
