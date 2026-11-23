// lib/parent.ts — the 20 parent-product lines and the x0.48 factor.
//
// A parent product's listed line is only one arm of a larger company, so
// its fitted value is discounted: a line keeps 48% of what the model
// fits. The list is a fixed data table carried over from the v4 entry;
// each value is the v4 description of the line, NOT a parent name.
// Matching is by exact slug, case-sensitive — never by substring and
// never by name, so a lookalike slug cannot be caught by accident.

export const PARENT_FACTOR = 0.48;

// Slug -> v4 description of the line. Order is the v4 order; it only
// matters for the run log, which lists detected lines in this order, and
// for the dashboard's parent tag, which shows the description verbatim.
export const PARENT_PRODUCTS: Record<string, string> = {
  "arcus-perps": "Arcus perps desk",
  "avant-avusd": "Avant avUSD stablecoin",
  "azverse-perps": "AZverse perps desk",
  "bitfi-basis": "BitFi basis-trading product",
  "cian-yield-layer": "CIAN yield product",
  "circle-gateway": "Circle cross-chain product",
  "defi-saver-asset-management": "DeFi Saver asset-management product",
  "extended-perps": "Extended perps desk",
  "figure-markets-exchange": "Figure Markets exchange arm",
  "figure-markets-prime": "Figure Markets prime arm",
  "ipor-fusion": "IPOR Fusion vault product",
  "loopscale-lending": "Loopscale lending product",
  "mellow-core": "Mellow core vault product",
  "nado-spot": "Nado spot product",
  "polymarket-international": "Polymarket international arm",
  "sentora-curator": "Sentora curator product",
  "solv-strategies": "Solv strategy product",
  "stellar-defi-hub": "Stellar DeFi hub product",
  "theo-network-thusd": "Theo Network thUSD stablecoin",
  "usdcx": "Circle USDCx wrapped product",
};

// Scale a dollar value by the parent factor, rounding to a whole dollar
// and never dropping below $1. The same function is used by the runner
// (main.ts) and by the bootstrap rank ranges, so the ranges are measured
// on the discounted board the reader actually sees.
export function parentScale(v: number): number {
  return Math.max(1, Math.round(v * PARENT_FACTOR));
}
