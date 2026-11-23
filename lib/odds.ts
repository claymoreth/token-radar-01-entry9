// lib/odds.ts — listing-probability logistic regression.
//
// Question: for a protocol with no token yet, how likely is DefiLlama to
// have a ticker RECORDED for it? The target is y = 1 when a ticker is
// recorded (gecko_id or symbol set), y = 0 when no token is recorded at
// all. Call it what it is: the chance a ticker exists in the record,
// NOT the chance the token trades, and NOT the chance it launches.
// "Recorded" is a low bar — it includes failed launches, illiquid
// placeholders and points systems that never reach price discovery.
//
// The regression is written from scratch, standard library only:
// full-batch gradient descent, a ridge penalty on every weight except
// the bias, numeric features standardised, family and category as
// separate ridge groups of raw 0/1 dummies. Nothing is hardcoded: every
// level, mean, scale and weight is fitted at run time from the rows it
// is handed.
//
// The v9 growth fix: the 7-day TVL growth figure (change_7d) is in
// PERCENT, not fractions — across the snapshot it runs from -72.7 to
// +4448 with median -8.2. The old growth feature clamped the raw value
// into [-0.9, 3], a clamp written for fractions, which collapsed 81% of
// rows to the single value -0.9 and destroyed almost all growth
// variation. The new "growthW" feature is clamp(g / 100, -0.5, 1.0),
// winsorised percent growth. Two interactions join it: age x ln(TVL)
// and ln(TVL) x growthW, each a single numeric column, each tested by
// the same sequential selection as every other group.

export interface OddsRow {
  slug: string;
  listedAt: string | null;
  ageYears: number | null;
  lnTvl: number;
  growthRaw: number | null;
  lnChains: number;
  family: string;
  category: string;
  y: number;
}

export type OddsTermKept = "kept" | "tested, not kept" | "baseline";

export interface OddsTermEvidence {
  name: string;
  brier: number;
  wfBrier: number;
  kept: OddsTermKept;
}

export interface OddsEvidence {
  n: number;
  baseRate: number;
  baselineBrier: number;
  baselineWfBrier: number;
  finalBrier: number;
  finalWfBrier: number;
  walkForwardCorrect: number;
  terms: OddsTermEvidence[];
}

// Candidate groups, in the order the sequential selection tries them.
// "growth" (the old fraction clamp) is gone; "growthW" replaces it, and
// the two interaction groups sit between the plain size term and it, so
// an interaction is only tried once its own ingredients are in play.
export const ODDS_GROUPS = [
  "age",
  "lntvl",
  "ageXlntvl",
  "lntvlXgrowthW",
  "growthW",
  "family",
  "category",
  "lnch",
] as const;
export type OddsGroup = (typeof ODDS_GROUPS)[number];

const GROUP_LABELS: Record<OddsGroup, string> = {
  age: "age (years listed)",
  lntvl: "ln(TVL)",
  ageXlntvl: "age x ln(TVL)",
  lntvlXgrowthW: "ln(TVL) x 7-day growth (winsorised)",
  growthW: "7-day TVL growth (winsorised %)",
  family: "family (ridge 16, raw dummies)",
  category: "category (ridge 16, raw dummies)",
  lnch: "chain count (ln)",
};

interface OddsStats {
  meanAge: number;
  meanGrowth: number;
  catLevels: string[];
  famLevels: string[];
  means: number[];
  sds: number[];
}

interface OddsModel {
  groups: OddsGroup[];
  stats: OddsStats;
  weights: number[];
  baseRate: number;
}

// Sigmoid with its input clamped first, so it can never overflow: at
// z = 30 the value is already 1 to machine precision, and at -30 it is 0.
function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

// The winsorised percent-growth feature. A missing growth figure uses
// the training set's mean raw growth (in percent) before the same
// divide-by-100 and clamp, so a row without a 7-day change still gets
// the average growth instead of a zero or a missing value.
function growthWValue(row: OddsRow, stats: OddsStats): number {
  const raw = row.growthRaw === null || row.growthRaw === undefined
    ? stats.meanGrowth
    : row.growthRaw;
  return Math.max(-0.5, Math.min(1.0, raw / 100));
}

// Raw design columns: walk the groups in order and append each group's
// column(s). Numeric columns are standardised downstream; family and
// category dummies are NOT standardised — they stay raw 0/1 values.
// Age is used with its mean fallback in both the plain age column and
// the age x ln(TVL) interaction, so the interaction is available for
// every row, dated or not.
function rawColumns(
  row: OddsRow,
  groups: readonly OddsGroup[],
  stats: OddsStats,
): number[] {
  const cols: number[] = [];
  const age = row.ageYears === null || row.ageYears === undefined
    ? stats.meanAge
    : row.ageYears;
  const growthW = growthWValue(row, stats);
  for (const group of groups) {
    if (group === "age") {
      cols.push(age);
    } else if (group === "lntvl") {
      cols.push(row.lnTvl);
    } else if (group === "ageXlntvl") {
      cols.push(age * row.lnTvl);
    } else if (group === "lntvlXgrowthW") {
      cols.push(row.lnTvl * growthW);
    } else if (group === "growthW") {
      cols.push(growthW);
    } else if (group === "lnch") {
      cols.push(row.lnChains);
    } else if (group === "family") {
      for (const level of stats.famLevels) {
        cols.push(row.family === level ? 1 : 0);
      }
    } else if (group === "category") {
      for (const level of stats.catLevels) {
        cols.push(row.category === level ? 1 : 0);
      }
    }
  }
  return cols;
}

// Column metadata, parallel to the raw columns: whether the column is a
// raw dummy (true for family/category, false for numeric columns) and
// the ridge penalty that applies to it — 16 for each dummy, 1 for each
// numeric column. The numeric penalty of 1 is the num_pen of the spec.
function columnInfo(
  groups: readonly OddsGroup[],
  stats: OddsStats,
): { raw: boolean[]; penalty: number[] } {
  const raw: boolean[] = [];
  const penalty: number[] = [];
  for (const group of groups) {
    if (group === "family") {
      for (let i = 0; i < stats.famLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else if (group === "category") {
      for (let i = 0; i < stats.catLevels.length; i++) {
        raw.push(true);
        penalty.push(16);
      }
    } else {
      raw.push(false);
      penalty.push(1);
    }
  }
  return { raw, penalty };
}

// Fit-time statistics: the two fallback means, the dummy levels, and
// the per-column mean and standard deviation used to standardise the
// numeric columns. Family levels need at least two rows to count — a
// singleton family cannot generalise, so it gets no dummy at all.
// Category levels are every category present, sorted alphabetically.
// Variances are population variances (divide by n, not n-1); a column
// with (near-)zero variance gets sd 1 so the division stays safe.
// After that, every RAW dummy column has its mean overridden to 0 and
// its sd to 1, so the design matrix passes the 0/1 values through
// unchanged.
function fitStats(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
): OddsStats {
  let ageSum = 0;
  let ageCount = 0;
  let growthSum = 0;
  let growthCount = 0;
  const famCounts = new Map<string, number>();
  const catSet = new Set<string>();
  for (const row of rows) {
    if (row.ageYears !== null && row.ageYears !== undefined) {
      ageSum += row.ageYears;
      ageCount += 1;
    }
    if (row.growthRaw !== null && row.growthRaw !== undefined) {
      growthSum += row.growthRaw;
      growthCount += 1;
    }
    famCounts.set(row.family, (famCounts.get(row.family) ?? 0) + 1);
    catSet.add(row.category);
  }
  const famLevels: string[] = [];
  for (const [fam, count] of famCounts) {
    if (count >= 2) famLevels.push(fam);
  }
  famLevels.sort();
  const catLevels = Array.from(catSet).sort();
  const stats: OddsStats = {
    meanAge: ageCount > 0 ? ageSum / ageCount : 0,
    meanGrowth: growthCount > 0 ? growthSum / growthCount : 0,
    catLevels,
    famLevels,
    means: [],
    sds: [],
  };
  const n = rows.length;
  // Build the raw matrix once and reuse it for every column's mean and
  // variance: the per-column sums still accumulate row by row in index
  // order, so the numbers are identical to computing each column
  // separately — only the repeated work is gone.
  const rawMatrix: number[][] = [];
  for (const row of rows) rawMatrix.push(rawColumns(row, groups, stats));
  const d = n === 0 ? 0 : rawMatrix[0].length;
  for (let j = 0; j < d; j++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += rawMatrix[i][j];
    mean = n > 0 ? mean / n : 0;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const diff = rawMatrix[i][j] - mean;
      variance += diff * diff;
    }
    variance = n > 0 ? variance / n : 0;
    stats.means.push(mean);
    stats.sds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  const info = columnInfo(groups, stats);
  for (let j = 0; j < d; j++) {
    if (info.raw[j]) {
      stats.means[j] = 0;
      stats.sds[j] = 1;
    }
  }
  return stats;
}

// The design matrix: each row's raw columns mapped to
// (value - mean) / sd, using the fit-time statistics.
function designMatrix(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
  stats: OddsStats,
): number[][] {
  const out: number[][] = [];
  for (const row of rows) {
    const raw = rawColumns(row, groups, stats);
    const mapped: number[] = [];
    for (let j = 0; j < raw.length; j++) {
      mapped.push((raw[j] - stats.means[j]) / stats.sds[j]);
    }
    out.push(mapped);
  }
  return out;
}

// Full-batch gradient descent for logistic regression. Weights start at
// zero; the bias (weights[0]) is unpenalised, every other weight pays
// its column's ridge penalty divided by n. Learning rate 0.15, at most
// 1000 iterations, stopping early when the largest single step drops
// below 1e-9 — at that point the fit has converged for any purpose here.
function fitLogistic(
  x: number[][],
  y: number[],
  penalties: number[],
): number[] {
  const n = x.length;
  const d = n === 0 ? 0 : x[0].length;
  const w: number[] = [];
  for (let j = 0; j < d + 1; j++) w.push(0);
  const lr = 0.15;
  for (let iter = 0; iter < 1000; iter++) {
    const grad: number[] = [];
    for (let j = 0; j < d + 1; j++) grad.push(0);
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * x[i][j];
      const err = sigmoid(z) - y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * x[i][j];
    }
    let maxStep = 0;
    for (let j = 0; j < d + 1; j++) {
      const penalty = j === 0 ? 0 : (penalties[j - 1] * w[j]) / n;
      const step = lr * (grad[j] / n + penalty);
      w[j] -= step;
      const abs = Math.abs(step);
      if (abs > maxStep) maxStep = abs;
    }
    if (maxStep < 1e-9) break;
  }
  return w;
}

// Fit the odds model on a set of rows under a chosen group list.
export function fitOdds(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
  baseRate: number,
): OddsModel {
  const stats = fitStats(rows, groups);
  const x = designMatrix(rows, groups, stats);
  const weights = fitLogistic(
    x,
    rows.map((r) => r.y),
    columnInfo(groups, stats).penalty,
  );
  return { groups: groups.slice() as OddsGroup[], stats, weights, baseRate };
}

// Predict one row's listing probability. The raw columns are
// standardised with the model's own means and sds, the linear score is
// pushed through the sigmoid, and the result is clipped to [0.02, 0.98]:
// a protocol is never priced as certainly tokenless or certainly
// tokenised, however extreme its features look.
export function predictOdds(model: OddsModel, row: OddsRow): number {
  const raw = rawColumns(row, model.groups, model.stats);
  let z = model.weights[0];
  for (let j = 0; j < raw.length; j++) {
    const x = (raw[j] - model.stats.means[j]) / model.stats.sds[j];
    z += model.weights[j + 1] * x;
  }
  const p = sigmoid(z);
  return Math.max(0.02, Math.min(0.98, p));
}

// Mean squared error between predicted probabilities and actual 0/1
// outcomes. Lower is better; a model that always predicts the base rate
// scores baseRate * (1 - baseRate).
export function brierScore(predicted: number[], actual: number[]): number {
  if (predicted.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < predicted.length; i++) {
    const diff = predicted[i] - actual[i];
    sum += diff * diff;
  }
  return sum / predicted.length;
}

// Expanding chronological folds over rows the caller has already sorted
// by (listedAt, slug). Four near-equal blocks; folds 0..2 train on
// blocks 0..k and test on block k+1, so every test row is strictly
// later than every training row in its fold. No look-ahead by
// construction.
export function expandingFolds<T>(sortedRows: T[]): { train: T[]; test: T[] }[] {
  const n = sortedRows.length;
  const chunks = 4;
  const base = Math.floor(n / chunks);
  const extra = n - base * chunks;
  const sizes: number[] = [];
  for (let b = 0; b < chunks; b++) sizes.push(base + (b < extra ? 1 : 0));
  const blocks: T[][] = [];
  let at = 0;
  for (let b = 0; b < chunks; b++) {
    blocks.push(sortedRows.slice(at, at + sizes[b]));
    at += sizes[b];
  }
  const folds: { train: T[]; test: T[] }[] = [];
  for (let k = 0; k < 3; k++) {
    const train: T[] = [];
    for (let b = 0; b <= k; b++) train.push(...blocks[b]);
    folds.push({ train, test: blocks[k + 1] });
  }
  return folds;
}

// Ten-fold Brier: rows sorted by slug, fold f holds out every tenth row
// (index % 10 === f) and trains on the other nine tenths. Deterministic
// — the fold assignment depends only on slug order, never on a shuffle.
function tenFoldBrier(rows: OddsRow[], groups: readonly OddsGroup[]): number {
  const ordered = rows.slice().sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  const predicted: number[] = [];
  for (let i = 0; i < ordered.length; i++) predicted.push(0);
  for (let fold = 0; fold < 10; fold++) {
    const train: OddsRow[] = [];
    const test: OddsRow[] = [];
    for (let i = 0; i < ordered.length; i++) {
      if (i % 10 === fold) test.push(ordered[i]);
      else train.push(ordered[i]);
    }
    if (test.length === 0) continue;
    let ySum = 0;
    for (const r of train) ySum += r.y;
    const baseRate = train.length > 0 ? ySum / train.length : 0;
    const model = fitOdds(train, groups, baseRate);
    for (const row of test) {
      predicted[ordered.indexOf(row)] = predictOdds(model, row);
    }
  }
  return brierScore(
    predicted,
    ordered.map((r) => r.y),
  );
}

// Walk-forward Brier: dated rows sorted by (listedAt, slug), scored on
// the three expanding folds. "Correct" is the share of test rows where
// the model's call — predicted above the overall base rate, or not —
// matches the actual outcome.
function walkForwardBrier(
  rows: OddsRow[],
  groups: readonly OddsGroup[],
): { brier: number; correct: number; n: number; predicted: number[]; actual: number[] } {
  const dated = rows
    .filter((r) => r.listedAt !== null)
    .sort((a, b) => {
      const da = a.listedAt as string;
      const db = b.listedAt as string;
      if (da !== db) return da < db ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    let ySum = 0;
    for (const r of fold.train) ySum += r.y;
    const baseRate = fold.train.length > 0 ? ySum / fold.train.length : 0;
    const model = fitOdds(fold.train, groups, baseRate);
    for (const row of fold.test) {
      predicted.push(predictOdds(model, row));
      actual.push(row.y);
    }
  }
  let ySumAll = 0;
  for (const r of rows) ySumAll += r.y;
  const baseRate = rows.length > 0 ? ySumAll / rows.length : 0;
  let correctCount = 0;
  for (let i = 0; i < actual.length; i++) {
    if ((predicted[i] > baseRate ? 1 : 0) === actual[i]) correctCount += 1;
  }
  return {
    brier: brierScore(predicted, actual),
    correct: actual.length > 0 ? correctCount / actual.length : 0,
    n: actual.length,
    predicted,
    actual,
  };
}

// Baseline walk-forward: the same dated folds, but each test row is
// predicted by its training fold's base rate instead of a model. This
// is the bar a group must beat — a model that cannot beat "always guess
// the base rate" has learned nothing.
function baselineWalkForwardBrier(rows: OddsRow[]): number {
  const dated = rows
    .filter((r) => r.listedAt !== null)
    .sort((a, b) => {
      const da = a.listedAt as string;
      const db = b.listedAt as string;
      if (da !== db) return da < db ? -1 : 1;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const fold of expandingFolds(dated)) {
    let ySum = 0;
    for (const r of fold.train) ySum += r.y;
    const rate = fold.train.length > 0 ? ySum / fold.train.length : 0;
    for (const row of fold.test) {
      predicted.push(rate);
      actual.push(row.y);
    }
  }
  return brierScore(predicted, actual);
}

// Sequential selection with evidence. Groups are tried in ODDS_GROUPS
// order; a group is KEPT only when adding it lowers the Brier on BOTH
// held-out tests — ten-fold AND walk-forward — against the groups kept
// so far. A group that helps one and hurts the other is reported
// "tested, not kept" and never used. The intercept-only base rate is
// the baseline term, and the final model is refit on the kept groups
// over all rows.
export function fitOddsWithEvidence(
  rows: OddsRow[],
): { model: OddsModel; evidence: OddsEvidence } {
  let ySum = 0;
  for (const r of rows) ySum += r.y;
  const baseRate = rows.length > 0 ? ySum / rows.length : 0;
  const baselineBrier = brierScore(
    rows.map(() => baseRate),
    rows.map((r) => r.y),
  );
  const baselineWfBrier = baselineWalkForwardBrier(rows);
  const terms: OddsTermEvidence[] = [
    {
      name: "intercept-only (base rate)",
      brier: baselineBrier,
      wfBrier: baselineWfBrier,
      kept: "baseline",
    },
  ];
  let kept: OddsGroup[] = [];
  let bestBrier = baselineBrier;
  let bestWfBrier = baselineWfBrier;
  let finalBrier = baselineBrier;
  let finalWfBrier = baselineWfBrier;
  let finalCorrect = 0;
  for (const group of ODDS_GROUPS) {
    const candidate: OddsGroup[] = [...kept, group];
    const brier = tenFoldBrier(rows, candidate);
    const wf = walkForwardBrier(rows, candidate);
    const helps = brier < bestBrier && wf.brier < bestWfBrier;
    terms.push({
      name: GROUP_LABELS[group],
      brier,
      wfBrier: wf.brier,
      kept: helps ? "kept" : "tested, not kept",
    });
    if (helps) {
      kept = candidate;
      bestBrier = brier;
      bestWfBrier = wf.brier;
      finalBrier = brier;
      finalWfBrier = wf.brier;
      finalCorrect = wf.correct;
    }
  }
  if (kept.length === 0) {
    finalCorrect = walkForwardBrier(rows, []).correct;
  }
  const model = fitOdds(rows, kept, baseRate);
  const evidence: OddsEvidence = {
    n: rows.length,
    baseRate,
    baselineBrier,
    baselineWfBrier,
    finalBrier,
    finalWfBrier,
    walkForwardCorrect: finalCorrect,
    terms,
  };
  return { model, evidence };
}
