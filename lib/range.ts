// lib/range.ts — seeded randomness, quantiles, intervals and coverage.
//
// Everything here is deterministic: the only randomness in the whole
// entry comes from mulberry32, seeded from the snapshot itself. No
// Math.random anywhere, no network, no clock reads.

export interface ResidualQuantiles {
  q10: number;
  q25: number;
  q75: number;
  q90: number;
}

// FNV-1a over UTF-16 code units, returning an unsigned 32-bit number.
// This is the seed hash: it turns the snapshot's date plus its slug list
// into the single seed every later stream derives from. It is a different
// function from the hex-string fnv1a in lib/integrity.ts, which hashes
// UTF-8 bytes for the board checksum — keep both, do not merge them.
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = hash ^ text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: a small, fast, seedable PRNG with a full 32-bit period for
// practical purposes. Each call advances the state by the golden-ratio
// constant and scrambles it twice; the result is uniform in [0, 1).
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Linear-interpolation quantile over an array the caller has already
// sorted ascending. q is in [0, 1]. The empty array has no quantile, so
// it reports 0; a single element is its own quantile at every q. The
// position is fractional, so the value between two neighbours is blended
// in proportion — never snapped to the nearer neighbour.
export function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = q * (sortedValues.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

// The four quantiles that draw every interval on the board, taken from a
// set of held-out log residuals. The caller passes the raw residuals;
// this function copies and sorts them first.
export function residualQuantiles(residuals: number[]): ResidualQuantiles {
  const sorted = residuals.slice().sort((a, b) => a - b);
  return {
    q10: quantile(sorted, 0.1),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    q90: quantile(sorted, 0.9),
  };
}

// Turn an implied value and a set of residual quantiles into the four
// interval bounds the board shows. Each bound is the implied value
// shifted by the exponent of one residual quantile, floored at $1 so no
// interval ever prints zero or a negative dollar.
export function intervalBounds(
  impliedValueUsd: number,
  q: ResidualQuantiles,
): { p25: number; p75: number; p10: number; p90: number } {
  return {
    p25: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q25))),
    p75: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q75))),
    p10: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q10))),
    p90: Math.max(1, Math.round(impliedValueUsd * Math.exp(q.q90))),
  };
}

// Share of actual values that fall inside their own interval, inclusive
// on both ends. This is the honesty check for the intervals: a P25–P75
// band that claims 50% should catch about half the held-out actuals.
export function coverageFraction(
  actual: number[],
  lower: number[],
  upper: number[],
): number {
  if (actual.length === 0) return 0;
  let inside = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] >= lower[i] && actual[i] <= upper[i]) inside += 1;
  }
  return inside / actual.length;
}
