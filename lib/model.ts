// lib/model.ts — value model, board builder, odds training rows.
//
// The board answers: if a protocol with no token issued one tomorrow,
// what would it be worth?
//
//   implied value = TVL x fitted multiple x listing probability
//
// The multiple is fitted from the snapshot's own priced protocols; the
// odds come from lib/odds.ts; the intervals come from lib/range.ts.
// Nothing is hardcoded to a name: every level, weight and multiple is
// fitted at run time, and every term is kept only when it lowers the
// held-out miss in BOTH out-of-sample tests.
//
// The v9 value model is fitted on the DATED priced rows only — the 95
// priced protocols with a listing date — because the walk-forward test
// can only be run on dated rows, so fitting on dated rows aligns the
// fit with the validation. The category term survives there at ridge
// lambda 32 (it failed at lambda 64 in v8), so v9 keeps flat + size +
// category. The flat median multiple and the per-category multiples
// shown as reference are still computed from ALL 128 priced protocols;
// only the fit itself uses the dated 95.

import { fitOddsWithEvidence, predictOdds } from "./odds.ts";
import type { OddsRow } from "./odds.ts";
import {
  coverageFraction,
  fnv1a,
  intervalBounds,
  mulberry32,
  quantile,
  residualQuantiles,
} from "./range.ts";
import type { ResidualQuantiles } from "./range.ts";
import { PARENT_PRODUCTS, parentScale } from "./parent.ts";

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Factors {
  multiple: number;
  size: number;
  category: number;
}

export interface FarmPlanStep {
  n: number;
  title: string;
  text: string;
  cost: string;
  time: string;
}

export interface PeerRow {
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  heldOut: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  rank: number;
  impliedValueUsd: number;
  valueIfLaunches: number;
  tokenOdds: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  bootstrapLow: number;
  bootstrapHigh: number;
  bootstrapRankLow: number;
  bootstrapRankHigh: number;
  factors: Factors;
  verdict: string;
  netFees: number;
  netPerHour: number;
  dropUsd: number;
  feesUsd: number;
  handsOnHours: number;
  depositUsd: number;
  dropShare: number;
  horizonWeeks: number;
  farmSteps: string[];
  farmPlan: FarmPlanStep[];
  exitRule: string;
  peers: PeerRow[];
  parentFactor?: number;
  parentName?: string;
}

export interface ValueTermEvidence {
  name: string;
  loo: number;
  wf: number;
  kept: "kept" | "tested, not kept" | "baseline" | "must not help";
}

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: "kept" | "tested, not kept" | "baseline";
}

export interface Evidence {
  value: {
    n: number;
    baselineLoo: number;
    baselineWf: number;
    finalLoo: number;
    finalWf: number;
    terms: ValueTermEvidence[];
  };
  odds: {
    n: number;
    baseRate: number;
    baselineBrier: number;
    baselineWfBrier: number;
    finalBrier: number;
    finalWfBrier: number;
    walkForwardCorrect: number;
    terms: OddsTermEvidence[];
  };
  range: {
    rows: { label: string; stated: number; loo: number; wf: number }[];
    note: string;
  };
}

export interface Board {
  model: string;
  as_of: string;
  rows: BoardRow[];
  multiples: { category: string; multiple: number; n: number }[];
  globalMultiple: number;
  liveCount: number;
  evidence: Evidence;
}

// Median of a numeric array: copy, sort ascending, take the middle, or
// the mean of the two middle values for an even length. Empty -> 0.
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Whole days between a listing date and the snapshot date, parsed as UTC
// midnights. Null listing date, or an unparseable date on either side,
// gives null — the row's age is simply unknown, and the models fall
// back to the training mean for it.
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86400000));
}

// A protocol's family is the first word of its trimmed name, lowercased;
// an empty name falls back to the slug. "Aave V2" and "Aave V3" are one
// family, "Aavegotchi" is another.
function familyOf(name: string, slug: string): string {
  const trimmed = name.trim();
  const first = trimmed === "" ? slug : trimmed.split(/\s+/)[0];
  return first.toLowerCase();
}

// ---- Exclusions: which protocols can be board candidates or odds rows.

// Categories whose tokens, where they exist, are not the kind of launch
// this board prices: exchanges, bridges, liquid staking and restaked BTC.
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Liquid Staking",
  "Bridge",
  "Canonical Bridge",
  "Liquid Restaking",
  "Restaked BTC",
]);

// A name ending in a version marker — "V2", "v3.1", "1.5" — is a
// versioned variant of another protocol, not a protocol of its own.
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
// A whole word "wrapped", "staked" or "staking", any case.
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
// Names that start with a centralised exchange's name.
const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

function isExcludedName(p: Protocol): boolean {
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return true;
  }
  return false;
}

function isNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

// A board candidate has no token on record, is not in an excluded
// category, and is not a versioned/wrapped/exchange-named variant.
function isBoardCandidate(p: Protocol): boolean {
  return (
    isNoToken(p) &&
    (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) &&
    !isExcludedName(p)
  );
}

// Odds training drops the same non-candidates as the board. The target
// itself differs (ticker recorded vs not), so no isNoToken check here.
function isOddsExcluded(p: Protocol): boolean {
  return (
    (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) ||
    isExcludedName(p)
  );
}

// ---- Value-model internals.

interface ModelRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  growthShuffled: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number | null;
}

type FeatureKey = "lnTvl" | "growth" | "growthShuffled" | "age" | "lnChains";

type Stage =
  | { kind: "const"; name: string }
  | { kind: "ols"; key: FeatureKey; name: string }
  | { kind: "group"; key: "family" | "category"; lambda: number; name: string };

interface FitStats {
  meanGrowth: number;
  meanAge: number;
}

function fitStatsOf(train: ModelRow[]): FitStats {
  let growthSum = 0;
  let growthCount = 0;
  let ageSum = 0;
  let ageCount = 0;
  for (const row of train) {
    if (row.growthRaw !== null && row.growthRaw !== undefined) {
      growthSum += row.growthRaw;
      growthCount += 1;
    }
    if (row.ageYears !== null && row.ageYears !== undefined) {
      ageSum += row.ageYears;
      ageCount += 1;
    }
  }
  return {
    meanGrowth: growthCount > 0 ? growthSum / growthCount : 0,
    meanAge: ageCount > 0 ? ageSum / ageCount : 0,
  };
}

// One feature's value for one row. Growth is clamped to [-0.9, 3] — the
// clamp written for the raw percent figure as the value model has always
// used it — with a missing figure falling back to the training mean.
function featureValue(row: ModelRow, key: FeatureKey, stats: FitStats): number {
  if (key === "lnTvl") return row.lnTvl;
  if (key === "growth") {
    const v = row.growthRaw === null || row.growthRaw === undefined
      ? stats.meanGrowth
      : row.growthRaw;
    return Math.max(-0.9, Math.min(3, v));
  }
  if (key === "growthShuffled") {
    const v = row.growthShuffled === null || row.growthShuffled === undefined
      ? stats.meanGrowth
      : row.growthShuffled;
    return Math.max(-0.9, Math.min(3, v));
  }
  if (key === "age") {
    return row.ageYears === null || row.ageYears === undefined
      ? stats.meanAge
      : row.ageYears;
  }
  return row.lnChains;
}

interface FittedStage {
  stage: Stage;
  intercept: number;
  slope: number;
  effects: Map<string, number>;
}

interface ValueModel {
  stages: FittedStage[];
  stats: FitStats;
}

// Fit the stages IN ORDER, each on the residuals of the ones before it.
// const takes the median residual; ols takes a one-variable least
// squares fit; group takes shrunk group means, where lambda
// pseudo-observations of zero pull small groups toward no effect.
function fitValueModel(train: ModelRow[], stages: Stage[]): ValueModel {
  const stats = fitStatsOf(train);
  const fitted: FittedStage[] = [];
  let residuals: number[] = train.map((r) => r.y as number);
  for (const stage of stages) {
    if (stage.kind === "const") {
      const a = median(residuals);
      fitted.push({ stage, intercept: a, slope: 0, effects: new Map() });
      residuals = residuals.map((r) => r - a);
    } else if (stage.kind === "ols") {
      const xs = train.map((r) => featureValue(r, stage.key, stats));
      let meanX = 0;
      for (const x of xs) meanX += x;
      meanX = xs.length > 0 ? meanX / xs.length : 0;
      let meanR = 0;
      for (const r of residuals) meanR += r;
      meanR = residuals.length > 0 ? meanR / residuals.length : 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxx += (xs[i] - meanX) * (xs[i] - meanX);
        sxy += (xs[i] - meanX) * (residuals[i] - meanR);
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const intercept = meanR - slope * meanX;
      fitted.push({ stage, intercept, slope, effects: new Map() });
      residuals = residuals.map(
        (r, i) => r - (intercept + slope * xs[i]),
      );
    } else {
      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      for (let i = 0; i < train.length; i++) {
        const key = stage.key === "family" ? train[i].family : train[i].category;
        sums.set(key, (sums.get(key) ?? 0) + residuals[i]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const effects = new Map<string, number>();
      for (const [key, sum] of sums) {
        effects.set(key, sum / ((counts.get(key) ?? 0) + stage.lambda));
      }
      fitted.push({ stage, intercept: 0, slope: 0, effects });
      residuals = residuals.map((r, i) => {
        const key =
          stage.key === "family" ? train[i].family : train[i].category;
        return r - (effects.get(key) ?? 0);
      });
    }
  }
  return { stages: fitted, stats };
}

// Predict one row's log multiple. sizePart accumulates the ln(TVL)
// stage's contribution and categoryPart the group stages' contribution,
// so the board can show how much of a row's multiple comes from size
// and how much from its category.
function predictValue(
  model: ValueModel,
  row: ModelRow,
): { total: number; sizePart: number; categoryPart: number } {
  let total = 0;
  let sizePart = 0;
  let categoryPart = 0;
  for (const fitted of model.stages) {
    const stage = fitted.stage;
    if (stage.kind === "const") {
      total += fitted.intercept;
    } else if (stage.kind === "ols") {
      const add =
        fitted.intercept +
        fitted.slope * featureValue(row, stage.key, model.stats);
      if (stage.key === "lnTvl") sizePart += add;
      total += add;
    } else {
      const key = stage.key === "family" ? row.family : row.category;
      const add = fitted.effects.get(key) ?? 0;
      categoryPart += add;
      total += add;
    }
  }
  return { total, sizePart, categoryPart };
}

// The miss of a set of predictions: exp of the median absolute log
// error. A miss of 3 means the typical prediction is off by a factor of
// 3 in either direction — the natural unit for a ratio model.
function missFactor(predicted: number[], actual: number[]): number {
  const errs: number[] = [];
  for (let i = 0; i < predicted.length; i++) {
    errs.push(Math.abs(predicted[i] - actual[i]));
  }
  return Math.exp(median(errs));
}

// Leave-one-out predictions: for each row, fit on all the others and
// predict the held-out row. Expensive (one fit per row) but honest —
// the row being scored never appears in its own training set.
function looPredictions(rows: ModelRow[], stages: Stage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const model = fitValueModel(train, stages);
    out.push(predictValue(model, rows[i]).total);
  }
  return out;
}

// Walk-forward predictions over dated rows: sort by (listedAt, slug),
// split into 4 near-equal blocks, train on blocks 0..k and predict
// block k+1. Every prediction is made by a model that has only ever
// seen earlier listings — no look-ahead.
function wfPredictions(
  dated: ModelRow[],
  stages: Stage[],
): { predicted: number[]; actual: number[] } {
  const sorted = dated.slice().sort((a, b) => {
    const da = a.listedAt as string;
    const db = b.listedAt as string;
    if (da !== db) return da < db ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const n = sorted.length;
  const base = Math.floor(n / 4);
  const extra = n - base * 4;
  const sizes: number[] = [];
  for (let b = 0; b < 4; b++) sizes.push(base + (b < extra ? 1 : 0));
  const blocks: ModelRow[][] = [];
  let at = 0;
  for (let b = 0; b < 4; b++) {
    blocks.push(sorted.slice(at, at + sizes[b]));
    at += sizes[b];
  }
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < 3; k++) {
    const train: ModelRow[] = [];
    for (let b = 0; b <= k; b++) train.push(...blocks[b]);
    const model = fitValueModel(train, stages);
    for (const row of blocks[k + 1]) {
      predicted.push(predictValue(model, row).total);
      actual.push(row.y as number);
    }
  }
  return { predicted, actual };
}

// The leave-one-out ratio lookup, built in Step 7 and read by the farm
// stage: for a priced peer, the model's held-out prediction of its
// cap/TVL ratio, over the peer's actual ratio. 1.00 means the model
// priced the peer exactly. A peer the variant never trained on falls
// back to 1 — no claim is made about it.
let looRatioBySlug = new Map<string, number>();

export function looRatioPredictor(): (peer: Protocol) => number {
  const snapshot = new Map(looRatioBySlug);
  return (peer: Protocol): number => {
    const actual =
      peer.mcap_usd !== null && peer.tvl_usd > 0
        ? peer.mcap_usd / peer.tvl_usd
        : 0;
    const predicted = snapshot.get(peer.slug);
    if (actual <= 0 || predicted === undefined) return 1;
    return predicted / actual;
  };
}

// The main pipeline. Steps follow the v6 spec; the v9 deltas are in
// Step 4 (dated-only training rows) and Step 5 (category at lambda 32,
// tested before family), and the odds rows in Step 9 use the
// ticker-recorded target.
export function buildBoardModel(snapshot: Snapshot): Board {
  // Step 1 — seed. The snapshot date plus every slug, in snapshot
  // order, hashed to one 32-bit seed.
  const seed = fnv1a(
    snapshot.as_of + "|" + snapshot.protocols.map((p) => p.slug).join(","),
  );

  // Step 2 — priced protocols. A protocol is priced when its market cap
  // is set, its TVL is positive, and the cap/TVL ratio is positive.
  // These are the reference numbers: the global median multiple and the
  // per-category multiples stay computed from ALL priced protocols.
  const priced: Protocol[] = [];
  const allRatios: number[] = [];
  const ratiosByCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (
      p.mcap_usd !== null &&
      p.tvl_usd > 0 &&
      p.mcap_usd / p.tvl_usd > 0
    ) {
      priced.push(p);
      const ratio = p.mcap_usd / p.tvl_usd;
      allRatios.push(ratio);
      const cat = p.category ?? "Uncategorized";
      const list = ratiosByCategory.get(cat) ?? [];
      list.push(ratio);
      ratiosByCategory.set(cat, list);
    }
  }
  const globalMultiple = median(allRatios);

  // Step 3 — category multiples, sorted by count descending then name
  // ascending. A category with fewer than 3 priced protocols gets the
  // global multiple instead of a noisy median of its own; the median
  // itself is clamped to [0.05, 1].
  const multiples: { category: string; multiple: number; n: number }[] = [];
  const catEntries = Array.from(ratiosByCategory.entries()).sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  for (const [category, ratios] of catEntries) {
    multiples.push({
      category,
      multiple:
        ratios.length >= 3
          ? Math.min(1, Math.max(0.05, median(ratios)))
          : globalMultiple,
      n: ratios.length,
    });
  }

  // Step 4 — value-model rows. v9: the fit uses the DATED priced rows
  // only (listed_at !== null), 95 of the 128 priced protocols, sorted
  // by slug. The shuffled-growth values are drawn from the dated set
  // itself, with the same seed derivation applied to the dated set's
  // own length.
  const datedPriced = priced
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const shuffleRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const perm: number[] = [];
  for (let i = 0; i < datedPriced.length; i++) perm.push(i);
  for (let i = perm.length - 1; i >= 1; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  function rowBuilder(p: Protocol, shuffledGrowth: number | null): ModelRow {
    const age = ageDays(snapshot.as_of, p.listed_at);
    return {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      growthShuffled: shuffledGrowth,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category ?? "Uncategorized",
      y:
        p.mcap_usd !== null && p.tvl_usd > 0
          ? Math.log(p.mcap_usd / p.tvl_usd)
          : null,
    };
  }
  const valueRows: ModelRow[] = datedPriced.map((p, i) =>
    rowBuilder(p, datedPriced[perm[i]].change_7d),
  );
  // Every value row is dated by construction, so the walk-forward set
  // is the training set itself.
  const datedRows = valueRows.filter((r) => r.listedAt !== null);
  const actuals: number[] = valueRows.map((r) => r.y as number);

  // Step 5 — sequential term selection. Stages in test order; a stage
  // is kept only when it lowers the miss on BOTH tests — leave-one-out
  // AND chronological walk-forward — against the stages kept so far.
  // The shuffled-growth control is tested last and NEVER kept, whatever
  // it scores: if shuffled noise ever "helped", the tests would be
  // broken, not the model improved.
  const constStage: Stage = { kind: "const", name: "flat median multiple" };
  const sizeStage: Stage = { kind: "ols", key: "lnTvl", name: "size curve ln(TVL)" };
  const categoryStage: Stage = {
    kind: "group",
    key: "category",
    lambda: 32,
    name: "category effect (ridge 32)",
  };
  const familyStage: Stage = {
    kind: "group",
    key: "family",
    lambda: 8,
    name: "family effect (ridge)",
  };
  const growthStage: Stage = { kind: "ols", key: "growth", name: "7-day TVL growth" };
  const ageStage: Stage = { kind: "ols", key: "age", name: "age (years listed)" };
  const chainsStage: Stage = { kind: "ols", key: "lnChains", name: "chain count (ln)" };
  const controlStage: Stage = {
    kind: "ols",
    key: "growthShuffled",
    name: "CONTROL shuffled growth",
  };
  function evaluate(stages: Stage[]): { loo: number; wf: number } {
    const looPreds = looPredictions(valueRows, stages);
    const wf = wfPredictions(datedRows, stages);
    return {
      loo: missFactor(looPreds, actuals),
      wf: missFactor(wf.predicted, wf.actual),
    };
  }
  let keptStages: Stage[] = [constStage];
  let current = evaluate(keptStages);
  const baseline = { ...current };
  const valueTerms: ValueTermEvidence[] = [
    {
      name: "flat median multiple",
      loo: current.loo,
      wf: current.wf,
      kept: "baseline",
    },
  ];
  for (const stage of [
    sizeStage,
    categoryStage,
    familyStage,
    growthStage,
    ageStage,
    chainsStage,
  ]) {
    const candidate = [...keptStages, stage];
    const score = evaluate(candidate);
    const helps = score.loo < current.loo && score.wf < current.wf;
    valueTerms.push({
      name: stage.name,
      loo: score.loo,
      wf: score.wf,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      keptStages = candidate;
      current = score;
    }
  }
  const controlScore = evaluate([...keptStages, controlStage]);
  valueTerms.push({
    name: "CONTROL shuffled growth",
    loo: controlScore.loo,
    wf: controlScore.wf,
    kept: "must not help",
  });

  // Step 6 — final fit and residuals. The LOO residuals draw the
  // board's intervals; the walk-forward residuals are the second,
  // chronological honesty check on the same bands.
  const finalValueModel = fitValueModel(valueRows, keptStages);
  const finalLooPreds = looPredictions(valueRows, keptStages);
  const looResiduals = actuals.map((y, i) => y - finalLooPreds[i]);
  const finalWf = wfPredictions(datedRows, keptStages);
  const wfResiduals = finalWf.actual.map(
    (y, i) => y - finalWf.predicted[i],
  );
  const looQuantiles: ResidualQuantiles = residualQuantiles(looResiduals);
  const wfQuantiles: ResidualQuantiles = residualQuantiles(wfResiduals);

  // Step 7 — LOO ratio lookup for the farm stage's peer table.
  looRatioBySlug = new Map(
    valueRows.map((row, i) => [row.slug, Math.exp(finalLooPreds[i])] as [string, number]),
  );

  // Step 8 — interval honesty (coverage), in ratio space. A band that
  // claims 50% should catch about half the held-out actuals; the table
  // reports the LOO and walk-forward shares side by side so the reader
  // can see whether it did.
  const looActualRatios = actuals.map((y) => Math.exp(y));
  const looPredRatios = finalLooPreds.map((p) => Math.exp(p));
  const looCover50 = coverageFraction(
    looActualRatios,
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q25)),
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q75)),
  );
  const looCover80 = coverageFraction(
    looActualRatios,
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q10)),
    looPredRatios.map((p) => p * Math.exp(looQuantiles.q90)),
  );
  const wfActualRatios = finalWf.actual.map((y) => Math.exp(y));
  const wfPredRatios = finalWf.predicted.map((p) => Math.exp(p));
  const wfCover50 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q25)),
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q75)),
  );
  const wfCover80 = coverageFraction(
    wfActualRatios,
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q10)),
    wfPredRatios.map((p) => p * Math.exp(wfQuantiles.q90)),
  );

  // Step 9 — odds training rows. Target: ticker RECORDED (gecko_id or
  // symbol set) vs no token recorded at all. The middle class — ticker
  // recorded but no usable cap — is now INCLUDED as y = 1; it is no
  // longer excluded from training. Excluded categories and
  // versioned/wrapped/exchange names are skipped, as on the board.
  const oddsRows: OddsRow[] = [];
  for (const p of snapshot.protocols) {
    if (isOddsExcluded(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    oddsRows.push({
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: age === null ? null : age / 365.25,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growthRaw: p.change_7d,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      family: familyOf(p.name, p.slug),
      category: p.category ?? "Uncategorized",
      y: p.gecko_id !== null || p.symbol !== null ? 1 : 0,
    });
  }
  const { model: oddsModel, evidence: oddsEvidence } =
    fitOddsWithEvidence(oddsRows);

  // Step 10 — board drafts. One draft per candidate, with its fitted
  // multiple, its listing probability, and the two dollar figures: what
  // it would be worth if it launched, and that figure times the odds.
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(isBoardCandidate);
  interface Draft {
    protocol: Protocol;
    implied: number;
    valueIfLaunches: number;
    odds: number;
    fittedMultiple: number;
    sizeFactor: number;
    categoryFactor: number;
    boardFeature: ModelRow;
    bootLow: number;
    bootHigh: number;
    bootRankLow: number;
    bootRankHigh: number;
  }
  const drafts: Draft[] = [];
  for (const p of candidates) {
    const boardFeature = rowBuilder(p, null);
    const oddsFeature: OddsRow = {
      slug: p.slug,
      listedAt: p.listed_at,
      ageYears: boardFeature.ageYears,
      lnTvl: boardFeature.lnTvl,
      growthRaw: boardFeature.growthRaw,
      lnChains: boardFeature.lnChains,
      family: boardFeature.family,
      category: boardFeature.category,
      y: 0,
    };
    const pred = predictValue(finalValueModel, boardFeature);
    const fittedMultiple = Math.exp(pred.total);
    const odds = predictOdds(oddsModel, oddsFeature);
    const valueIfLaunches = Math.max(
      1,
      Math.round(p.tvl_usd * fittedMultiple),
    );
    const implied = Math.max(
      1,
      Math.round(p.tvl_usd * fittedMultiple * odds),
    );
    drafts.push({
      protocol: p,
      implied,
      valueIfLaunches,
      odds,
      fittedMultiple,
      sizeFactor: Math.exp(pred.sizePart),
      categoryFactor: Math.exp(pred.categoryPart),
      boardFeature,
      bootLow: implied,
      bootHigh: implied,
      bootRankLow: 1,
      bootRankHigh: 1,
    });
  }

  // Step 11 — bootstrap (200 refits). Each refit resamples the value
  // rows with replacement and refits the same kept stages; the odds are
  // held FIXED, so the bootstrap measures the multiple's wobble, not
  // the odds'. Parent lines are discounted inside the refits, so the
  // rank ranges are measured on the discounted board the reader sees.
  const bootRng = mulberry32(seed);
  const bootCount = 200;
  const bootImplied: number[][] = drafts.map(() => []);
  const bootRanks: number[][] = drafts.map(() => []);
  for (let b = 0; b < bootCount; b++) {
    const resample: ModelRow[] = [];
    for (let i = 0; i < valueRows.length; i++) {
      resample.push(valueRows[Math.floor(bootRng() * valueRows.length)]);
    }
    const bootModel = fitValueModel(resample, keptStages);
    const bootValues = drafts.map((draft) =>
      Math.max(
        1,
        Math.round(
          draft.protocol.tvl_usd *
            Math.exp(predictValue(bootModel, draft.boardFeature).total) *
            draft.odds,
        ),
      ),
    );
    for (let i = 0; i < drafts.length; i++) bootImplied[i].push(bootValues[i]);
    const rankedValues = bootValues.map((v, i) =>
      PARENT_PRODUCTS[drafts[i].protocol.slug] !== undefined
        ? parentScale(v)
        : v,
    );
    const order = drafts
      .map((_, i) => i)
      .sort((a, c) => {
        if (rankedValues[c] !== rankedValues[a])
          return rankedValues[c] - rankedValues[a];
        if (drafts[c].protocol.tvl_usd !== drafts[a].protocol.tvl_usd)
          return drafts[c].protocol.tvl_usd - drafts[a].protocol.tvl_usd;
        return drafts[a].protocol.slug < drafts[c].protocol.slug
          ? -1
          : drafts[a].protocol.slug > drafts[c].protocol.slug
            ? 1
            : 0;
      });
    order.forEach((draftIndex, place) => {
      bootRanks[draftIndex].push(place + 1);
    });
  }
  for (let i = 0; i < drafts.length; i++) {
    const sortedImplied = bootImplied[i].slice().sort((a, b) => a - b);
    const sortedRanks = bootRanks[i].slice().sort((a, b) => a - b);
    drafts[i].bootLow = quantile(sortedImplied, 0.05);
    drafts[i].bootHigh = quantile(sortedImplied, 0.95);
    drafts[i].bootRankLow = Math.round(quantile(sortedRanks, 0.05));
    drafts[i].bootRankHigh = Math.round(quantile(sortedRanks, 0.95));
  }

  // Step 12 — rank and nudge. Sort by implied value, then TVL, then
  // slug; then nudge any tie down by $1 so implied values are strictly
  // decreasing down the board.
  drafts.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.protocol.tvl_usd !== a.protocol.tvl_usd)
      return b.protocol.tvl_usd - a.protocol.tvl_usd;
    return a.protocol.slug < b.protocol.slug
      ? -1
      : a.protocol.slug > b.protocol.slug
        ? 1
        : 0;
  });
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i].implied >= drafts[i - 1].implied) {
      drafts[i].implied = drafts[i - 1].implied - 1;
    }
  }

  // Step 13 — rows. Field order here is the JSON key order; the farm
  // placeholders are replaced by lib/farm.ts before the board is
  // written, so they never reach the reader.
  const rows: BoardRow[] = drafts.map((draft, i) => {
    const p = draft.protocol;
    const bounds = intervalBounds(draft.implied, looQuantiles);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      chains: p.chains,
      tvlUsd: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageDays(snapshot.as_of, p.listed_at),
      watchlist: watchlist.has(p.slug),
      rank: i + 1,
      impliedValueUsd: draft.implied,
      valueIfLaunches: draft.valueIfLaunches,
      tokenOdds: draft.odds,
      p25: bounds.p25,
      p75: bounds.p75,
      p10: bounds.p10,
      p90: bounds.p90,
      bootstrapLow: Math.max(1, Math.round(Math.min(draft.bootLow, draft.implied))),
      bootstrapHigh: Math.max(1, Math.round(Math.max(draft.bootHigh, draft.implied))),
      bootstrapRankLow: draft.bootRankLow,
      bootstrapRankHigh: draft.bootRankHigh,
      factors: {
        multiple: draft.fittedMultiple,
        size: draft.sizeFactor,
        category: draft.categoryFactor,
      },
      verdict: "MARGINAL",
      netFees: 0,
      netPerHour: 0,
      dropUsd: 0,
      feesUsd: 0,
      handsOnHours: 0,
      depositUsd: 0,
      dropShare: 0,
      horizonWeeks: 0,
      farmSteps: [
        "Placeholder langkah farm 1 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 2 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 3 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 4 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 5 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
        "Placeholder langkah farm 6 dari 6 — subagent farm mengganti teks ini dengan langkah nyata sebelum submit.",
      ],
      farmPlan: [],
      exitRule: "",
      peers: [],
    };
  });

  // Step 14 — evidence and return. The value evidence's n is the dated
  // training-set size (95), and its LOO/WF numbers are computed on that
  // set — the README states the training set so the numbers are
  // interpretable. The range note says plainly where the intervals come
  // from and what the coverage shares mean.
  const evidence: Evidence = {
    value: {
      n: valueRows.length,
      baselineLoo: baseline.loo,
      baselineWf: baseline.wf,
      finalLoo: current.loo,
      finalWf: current.wf,
      terms: valueTerms,
    },
    odds: oddsEvidence,
    range: {
      rows: [
        { label: "P25–P75", stated: 0.5, loo: looCover50, wf: wfCover50 },
        { label: "P10–P90", stated: 0.8, loo: looCover80, wf: wfCover80 },
      ],
      note: "Intervals are the implied value shifted by the quantiles of the value model's own held-out log residuals (LOO residuals for the board bounds). Coverage is the share of dated priced protocols whose real cap fell inside the interval: LOO over the 95 dated priced rows, walk-forward over the same dated rows with a walk-forward prediction.",
    },
  };
  return {
    model: "radar-10",
    as_of: snapshot.as_of,
    rows,
    multiples,
    globalMultiple,
    liveCount: valueRows.length,
    evidence,
  };
}
