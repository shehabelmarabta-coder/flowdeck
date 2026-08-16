# FlowDeck v0.3 research and audit notes

Research was read-only, limited to the repository/current audit plus the six anchors below. No repository was cloned, installed or executed. No Dune query was made.

## Verified technical facts

### Solana observation

- Official [`logsSubscribe`](https://solana.com/docs/rpc/websocket/logssubscribe) documentation says a `mentions` filter currently accepts exactly one base58 address; more than one is invalid. A notification contains a subscription ID, context slot, signature, error and logs. It is a notification source, not a price feed or decoded trade.
- `processed`, `confirmed` and `finalized` are supported commitment values. FlowDeck uses `processed` only for low-latency observation, then independently fetches and reconciles the transaction.
- Official [`getSignaturesForAddress`](https://solana.com/docs/rpc/http/getsignaturesforaddress) returns matching signatures newest-first and exposes `before`, `until`, `limit`, slot, error, block time and confirmation status. Catch-up therefore has to reverse the missing prefix before processing it.

### Jupiter paper evidence

- Official Jupiter Swap V2 [`/order` documentation](https://developers.jup.ag/docs/swap/order-and-execute) defines `amount` as the smallest-unit input amount.
- Without `taker`, `/order` returns a quote but no assembled transaction. With a public taker, a non-empty base64 `transaction` is buildable evidence. An empty transaction can still carry quoted pricing plus router-specific error details.
- Relevant response evidence includes `requestId`, `outAmount`, `router`, `mode`, fee fields, `errorCode` and `errorMessage`. The documentation explicitly distinguishes expected route output from amounts that would ultimately reach a wallet after execution.
- FlowDeck v0.3 calls `/order` only. It contains no signing step and no `/execute` request path. A Jupiter API key, when required by the service, is read from the process environment and never written to state, UI diagnostics or audit rows.

### Maintained educational repository

- [`chainstacklabs/pumpfun-bonkfun-bot`](https://github.com/chainstacklabs/pumpfun-bonkfun-bot) was inspected only at the repository metadata/README level. It has an Apache-2.0 license, named maintainers, approximately 285 commits at inspection time, dependency lock data and an explicit scam/private-key warning.
- Reused architecture patterns only: listener/parser/strategy/execution separation, reconnectable listeners, configuration boundaries, persistent state and simulation fixtures. No trading threshold, private-key example, transaction construction or execution code was copied.

### Topic-page safety review

- The GitLab [`solana`](https://gitlab.com/explore/projects/topics/solana) and [`pumpfun`](https://gitlab.com/explore/projects/topics/pumpfun) topic pages contain low-context projects, including drainers, address-poisoning tools and bundlers. Topic membership is not a quality signal.
- These pages were useful only to confirm exclusions: no Jito/bundling, wallet generation, artificial volume, address poisoning, exploit code or unverified performance claims enter FlowDeck.

### Research-paper caveat

- [`arXiv:2606.08232`](https://arxiv.org/abs/2606.08232) is titled *Hour-Aware Adaptive Risk Management for Autonomous Memecoin Trading on Solana DEXs*. Its landing page identifies a short deployment and multiple revisions. It is not treated as independent proof of profitability, and the supplied description “counterfactual/rejection-measurement preprint” does not match the paper title/abstract metadata closely enough to rely on it for that claim.
- The only adopted general lesson is methodological: record deployment context, censoring and rejected/missing outcomes. FlowDeck does not copy its thresholds.

## Qualitative trader hypotheses, not labels

- Reflexive attention, narrative, wallet flow and liquidity can matter at different horizons, but none is reliable labelled training data here.
- The supplied Ansem X page and YouTube interview were not machine-readable during this audit. No statement was inferred or encoded from inaccessible content.
- `narrative_context` exists as a future-compatible feature with `available: false`. No X scraping, social API or influencer override is implemented.
- Unique economic actors, independent wallet clusters and amount-specific sellability rank above raw transaction counts or famous-wallet associations.

## Local append-only audit reproduction

Source files inspected in place:

- `data/audit/flowdeck-paper-events-2026-08-14.csv`
- `data/audit/flowdeck-paper-trades-2026-08-14.csv`

The trade ledger reproduces 25 closed positions, 15 unique closed mints, 10 wins, 15 losses, net `0.0586430534603284 SOL`, average hold `89,498.76 ms`, best `0.0578221300739735 SOL`, and worst `-0.005338983192212 SOL`.

The events file had continued appending after the baseline described in the brief. At inspection it contained 37 wallet sells and 39 `CANDIDATE_CREATED` rows, versus the earlier 35/37 snapshot. The trade ledger remained at 25 closed positions. This is a time-of-export difference, not evidence that the supplied baseline was fabricated.

Confirmed defects:

- The old paper adapter labelled Dexscreener and other reference marks `EXECUTABLE_PRICE` without an amount-specific route.
- Entry event versus trade entry values differ by roughly the contemporaneous SOL/USD factor because SOL-unit and USD-unit fields were mixed.
- `position.sourceWallets` and `position.sourceSignatures` retained candidate arrays by reference, allowing later signals to mutate entry evidence.
- Final trade rows read candidate consensus at closure instead of an immutable entry snapshot.
- Open and post-exit samples shared `POSITION_SAMPLE`, requiring notes parsing and risking accidental realised-statistic contamination.
- Atomic token balances in `src/solana-parser.js` and legacy GMGN portfolio paths used JavaScript `Number`.

`npm run reconcile:audit` now reproduces the baseline and reports schema/time differences explicitly.

## Rejected scope and patterns

- No live execution, signing, Jupiter `/execute`, GMGN swap, private key, seed phrase or taker secret.
- No Dune, leaderboard refresh, cloud database, large ML framework, Telegram, X scraping or social API.
- No direct bonding-curve execution; almost-bonded tokens without Jupiter routes remain observed/censored evidence.
- No guaranteed-profit claims, copied bot thresholds, funding-graph crawler, bundler, Jito, front-running, artificial volume, drainers or exploit code.
- No model trained only on the 25 completed rows. The transparent Bayesian policy reports weak evidence and retains the prior equivalent sample size in every immutable snapshot.
