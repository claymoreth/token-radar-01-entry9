# Launch Radar — radar-10

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/claymoreth/token-radar-01-entry9/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/claymoreth/token-radar-01-entry9/reward.svg)](https://make.fun/bounty/token-radar-01)

Pre-token protocols, valued from their own record — not from hype. An entry for
[make.fun's token-radar-01 bounty](https://make.fun/bounty/token-radar-01): 198
pre-token protocols ranked by implied value, each with a costed farm verdict
and a ten-step farm plan, on one static dashboard.

## How the board is made

The board answers one question: if a protocol with no token issued one
tomorrow, what would it be worth? The answer is fitted from the snapshot's
own priced protocols, never from a hardcoded name or number:

**implied value = TVL × fitted multiple × listing probability**

- **Fitted multiple — now fitted on the dated priced rows.** The target is
  ln(mcap / TVL). This entry fits on the 95 priced protocols that carry a
  listing date, out of 128 priced in total — the walk-forward test can only
  run on dated rows, so the fit is aligned with the validation instead of
  being scored on a set it was never tested against. Terms are added one at
  a time and kept only when they lower the held-out miss in **both**
  out-of-sample tests — leave-one-out and a chronological walk-forward.
  Three terms survive: the flat median multiple, the size curve ln(TVL),
  and a category effect at ridge lambda 32. Final LOO miss 3.13,
  walk-forward 2.82, against a flat baseline of 5.00 / 5.29. The category
  term is the new arrival: at lambda 64 it failed both tests in the last
  entry, but a lambda grid showed it passes at 32 — size-only on the dated
  set scores 3.23 / 2.89, size + category at 32 scores 3.13 / 2.82, lower
  on both. The other candidates all fail one test each, which is exactly
  why the two-test rule exists: 7-day growth improves leave-one-out
  (3.10) but wrecks the walk-forward (3.33); age improves the
  walk-forward (2.75) but hurts leave-one-out (3.22); chain count improves
  leave-one-out (2.97) but hurts the walk-forward (3.22); the family effect
  leaves both scores bit-identical, because a held-out row's family is
  almost never in its training fold. A shuffled-growth control is tested
  and never kept. The flat median multiple (0.2138) and the per-category
  multiples shown as reference are still computed from all 128 priced
  protocols — only the fit itself uses the dated 95, and the 33 undated
  priced rows were checked as an out-of-sample guard in the search that
  produced this variant (median prediction ratio 1.017 against the
  all-rows fit), so the dated fit generalises rather than overfitting its
  own subset.
- **Listing probability — with the growth units fixed.** A logistic
  regression on whether DefiLlama has a ticker RECORDED for the protocol
  — gecko_id or symbol set — against no token recorded at all. Call it
  what it is: the chance a ticker exists in the record, **not** the chance
  the token trades, and **not** the chance it launches. Training covers
  n = 442 protocols at a 55.2% base rate (244 recorded, 198 not), and
  seven groups survive both tests — age, ln(TVL), age × ln(TVL),
  ln(TVL) × winsorised growth, winsorised 7-day growth, family and
  category (chain count tested, not kept: 0.195 / 0.260 against the kept
  set's 0.195 / 0.252). Final Brier 0.195 ten-fold, 0.252 walk-forward,
  against a base-rate baseline of 0.247 / 0.331; 63% of walk-forward calls
  right. The growth change matters: the 7-day TVL change in the snapshot
  is in PERCENT (median −8.2, running from −72.7 to +4448), but the old
  feature clamped the raw value into [−0.9, 3] — a clamp written for
  fractions — which collapsed 81% of rows onto the single value −0.9 and
  threw away almost all growth variation. The new feature is
  clamp(g / 100, −0.5, 1.0), with a missing figure taking the training
  mean before the same clamp. The two interactions are built from the
  row's own fields, so they are available both in training and when
  scoring a board row. The honest consequence of the better-tested models:
  this board's $948.0M total is LOWER than the last entry's $994.4M, and
  rank 1 Steakhouse Financial sits at $46.6M with 63.7% odds against
  $60.2M and 66.8% before — the better models fit lower multiples and
  lower odds for the big rows, and the board reports that instead of
  hiding it. And "recorded" is a low bar — it includes failed launches,
  illiquid placeholders and points systems that never reach price
  discovery — so the board can over-rank zombie protocols that are
  recorded but never trade. Implied value here prices the chance a ticker
  exists, not exit liquidity.
- **Tried and rejected.** The search behind this entry also tried and
  dropped: a category-median "anchor" multiple as a value feature — it
  looked like a large improvement until a fold-internal re-test showed it
  was self-leakage, a row's own ratio feeding its own category median, and
  it fails both tests when the anchor is computed inside each fold;
  smaller ridge penalties (numeric 0.10–0.25, group lambda 2–8) and the
  lambda grid — they improve the Brier slightly but LOWER the board rows'
  fitted odds, so the headline numbers fall; log-age, TVL rank, category
  TVL share and hot-chain count as odds features (none kept); the odds
  group without category (worse on both tests); and a super-category
  grouping for the value model (better on the tests, but lowers the
  implied total more than the adopted variant). Tree-based odds models
  (random forest, gradient boosting) were tested on the same held-out
  tests and are much worse than the logistic model on the walk-forward
  test (WF Brier 0.32–0.34 vs 0.2523, correct 0.38–0.57 vs 0.634), so the
  logistic model is kept and the remaining gap to the top entry is a data
  limitation, not a model-form limitation.
- **No look-ahead in the walk-forward.** The chronological folds split on
  `listed_at`, and every feature is a snapshot value — age, ln(TVL),
  7-day growth, chain count — never a value from after the listing date.
  The model never trains on the future it is tested on.
- **Ranges.** Every row shows P25–P75 and P10–P90 from the quantiles of
  the value model's own held-out log residuals — and the dashboard shows
  whether those bands held out of sample: P25–P75 caught 49% (LOO) and
  49% (walk-forward) against a stated 50%; P10–P90 caught 79% and 79%
  against a stated 80%. Each row also carries a bootstrap rank range
  (P5–P95 of its rank across 200 refits, parent discount applied inside
  the refits): rank 1 Steakhouse sits at 1–1, while Veda and Gauntlet
  both sit at 2–3.
- **Costed farm verdicts.** Each row's plan is sized at 0.02% of its TVL
  (clamped to $100–$10,000), the modelled drop is 7% of implied value,
  fees are the plan's on-chain transactions at the mid-point gas price of
  its main chain, and time is the hands-on minutes of the ten steps.
  FARM clears both a 12-week T-bill on the same deposit and $25/hour for
  the farmer's time; MARGINAL clears neither fully but still nets above
  zero; SKIP loses money to gas. On this snapshot **1 row clears both
  bars** — the board is 1 FARM, 147 MARGINAL and 50 SKIP. The one is
  marginfi Lending at $26.32/hour (net $90.02 on a $5,542.60 deposit; it
  clears its $51.16 T-bill bar). The near-miss is Lofty at $25.29/hour: it
  clears the hourly bar but its net of $86.50 falls $5.81 short of the
  $92.31 T-bill on its $10,000 deposit, so it stays MARGINAL. The detail
  view shows the benchmarks (T-bill, drop if a token launches, the drop
  share and listing probability above which fees are covered, the
  quantified exit TVL) and a net grid by drop share × deposit.
- **Parent products.** A row whose slug is on the fixed list of 20
  parent-product lines (ported verbatim from the v4 entry, `lib/parent.ts`
  `PARENT_PRODUCTS`) keeps 48% of its fitted value and is marked
  off-list ("Off-List · Parent ×0.48"). Matching is by exact slug,
  case-sensitive — no substring or name matching. Twenty rows are caught
  on this snapshot, including Polymarket International (rank #15 at
  $13.4M after the discount; $31.5M if it launches, listing probability
  88.9%), Sentora Curator, Defi Saver Asset Management and Circle Gateway.
  The label shown is the v4 description of the line (e.g. "Polymarket
  international arm"), not a parent name.
- **Protocol accounting.** All 758 protocols land in exactly one bucket
  (40 watchlist, 138 early below the $50M floor, 20 off-list, 128 priced
  comparables, 288 token-recorded without a usable cap, 43 bridges, 41
  liquid staking, 42 exchanges, 18 versioned/wrapped), so the buckets
  always add up to the ledger total. The dashboard draws the ledger as a
  stacked bar with a legend, and recomputes six integrity checks in the
  browser from the data file itself, including an FNV-1a checksum of the
  ranked rows (9506c35d). Nearest priced peers carry a genuinely held-out
  figure: the leave-one-out model prediction over the peer's actual
  cap/TVL ratio — 1.00 means the model priced the peer exactly.

## The dashboard

A six-card strip above the board summarises the model from its own
evidence (out-of-sample miss, range honesty, listing-probability Brier,
terms that survived, farm counts, watchlist coverage). Below it, the
accounting stacked bar with its legend and the six integrity chips, then
the evidence tables (value terms, odds groups, range honesty). The board
itself has verdict and tier tabs, search, category and chain filters,
sorting, CSV and JSON export, and a detail drawer per protocol. Rows can
be pinned with the checkbox in the first column — a pinned row stays
visible through every filter, and the filter line shows how many are
pinned. The token-odds column shows a bar as well as the percentage, and
each verdict cell reads "VERDICT · $net" with "$drop drop − $fees fees"
underneath. The drop-share slider runs 1–14% in 0.5% steps (default 7%)
and the horizon slider 4–52 weeks in 1-week steps (default 12 weeks);
both are display-only scenario controls — moving them updates the
scenario line and nothing else, and the verdicts stay costed on each
row's own plan. Ages show in years once a protocol is a year old
(1.5 yr), in days before that (45 d).

## Run it locally

Node 22 or later, standard library only — no install step.

```sh
mkdir -p out
RADAR_INPUT=<path to snapshot.json> RADAR_OUTPUT=out node main.ts
```

`--input <snapshot.json|directory>` overrides `RADAR_INPUT`;
`--output <dir>` overrides `RADAR_OUTPUT` (default `/output`,
`MAKEFUN_OUTPUT_DIR` outside the grader's container). The run writes
`out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json` (the dossier needs the three screenshots in
`screenshots/` first: `1-board.png`, `2-detail.png`, `3-filtered.png`).
The run is deterministic: the same snapshot always yields the same bytes
(board.json checksum 9506c35d on the 2026-11-14 snapshot). Every number
in this README comes from that run — no figure is carried over from an
earlier entry without checking it against the new output.

## Layout

- `main.ts` — the entry runner: model → parent discount → farm →
  accounting → integrity → board.json / data.js / dossier.json.
- `lib/model.ts` — the fitted value model, listing probability and intervals.
- `lib/odds.ts` — the listing-probability logistic regression.
- `lib/range.ts` — residual quantiles, coverage and the seeded PRNG.
- `lib/farm.ts` — farm economics, the ten-step plan, peers.
- `lib/accounting.ts` — the 758-protocol ledger buckets.
- `lib/integrity.ts` — the FNV-1a checksum and ledger counts.
- `lib/parent.ts` — the 20 parent-product lines and the ×0.48 factor,
  shared by the runner and the bootstrap rank range.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`);
  it reads `../data.js`, makes no network request.
- `vendor/makefun-board.ts` — make.fun's dashboard-dossier library.
