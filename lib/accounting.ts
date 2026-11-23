// lib/accounting.ts — the 758-protocol ledger buckets.
//
// Every protocol in the snapshot lands in exactly one bucket, so the
// buckets always add up to the ledger total. A protocol is tested top to
// bottom and takes the FIRST bucket it matches, which is why the order
// below is part of the definition, not a presentation choice.

export interface AccountingProtocol {
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

export interface AccountingSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: AccountingProtocol[];
  watchlist: string[];
}

export interface AccountingGroup {
  key: string;
  label: string;
  count: number;
}

export interface Accounting {
  total: number;
  groups: AccountingGroup[];
  ranked: number;
  watchlist: number;
}

// Category sets that send a protocol straight to an "Out" bucket. Bridge
// and liquid-staking families are excluded from the board because their
// tokens, where they exist, are not the kind of launch this board prices.
const BRIDGE_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
]);
const LIQUID_STAKING_CATEGORIES = new Set([
  "Liquid Staking",
  "Liquid Restaking",
]);

// The nine buckets, in priority order. The floor label is derived from
// the snapshot's floor_usd, never hardcoded: with a $50,000,000 floor it
// reads "$50M". The labels are the ones the dashboard's stacked bar
// shows, in this same order.
function groupDefinitions(floorUsd: number): AccountingGroup[] {
  const floorLabel =
    floorUsd >= 1e6 ? "$" + floorUsd / 1e6 + "M" : "$" + floorUsd;
  return [
    { key: "ranked-watchlist", label: "Ranked — on the 40-name watchlist", count: 0 },
    {
      key: "ranked-early-below-floor",
      label: `Ranked — early, pre-token, below the ${floorLabel} floor`,
      count: 0,
    },
    {
      key: "ranked-off-list",
      label: "Ranked — pre-token, off the watchlist and above the floor",
      count: 0,
    },
    {
      key: "token-trades-priced-comp",
      label: "Priced token — trades, used as a comparable",
      count: 0,
    },
    {
      key: "token-recorded-no-usable-cap",
      label: "Token recorded, but no usable market cap",
      count: 0,
    },
    { key: "out-bridge", label: "Out — bridge", count: 0 },
    {
      key: "out-liquid-staking",
      label: "Out — liquid staking / restaking",
      count: 0,
    },
    { key: "out-exchange", label: "Out — centralised exchange", count: 0 },
    {
      key: "out-versioned-or-wrapped",
      label:
        "Out — versioned/wrapped variant, or unranked pre-token with no recorded token",
      count: 0,
    },
  ];
}

// Classify one protocol. First match wins, in definition order:
// ranked rows first (watchlist, then early below the floor, then the
// rest), then priced tokens that trade, then tokens recorded without a
// usable cap, then the three excluded families, and finally everything
// left over — versioned or wrapped variants and unranked pre-token
// protocols with no token on record.
function classify(
  p: AccountingProtocol,
  ranked: Set<string>,
  watchlist: Set<string>,
  floorUsd: number,
): string {
  if (ranked.has(p.slug) && watchlist.has(p.slug)) return "ranked-watchlist";
  if (ranked.has(p.slug) && p.tvl_usd < floorUsd && p.mcap_usd === null)
    return "ranked-early-below-floor";
  if (ranked.has(p.slug)) return "ranked-off-list";
  if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    return "token-trades-priced-comp";
  if (p.symbol !== null || p.gecko_id !== null)
    return "token-recorded-no-usable-cap";
  if (p.category !== null && BRIDGE_CATEGORIES.has(p.category))
    return "out-bridge";
  if (p.category !== null && LIQUID_STAKING_CATEGORIES.has(p.category))
    return "out-liquid-staking";
  if (p.category === "CEX") return "out-exchange";
  return "out-versioned-or-wrapped";
}

// Walk the snapshot in its own order, drop every protocol into its
// bucket, and return the ledger. Expected counts on the 2026-11-14
// snapshot: total 758; groups in order 40 / 138 / 20 / 128 / 288 /
// 43 / 41 / 42 / 18; ranked 198; watchlist 40. The groups always sum
// to the total — a protocol that matched no bucket would be a bug, and
// the classifier's final branch exists precisely so that cannot happen.
export function buildAccounting(
  snapshot: AccountingSnapshot,
  rows: { slug: string }[],
): Accounting {
  const ranked = new Set(rows.map((r) => r.slug));
  const watchlist = new Set(snapshot.watchlist);
  const groups = groupDefinitions(snapshot.floor_usd);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const p of snapshot.protocols) {
    const key = classify(p, ranked, watchlist, snapshot.floor_usd);
    const group = byKey.get(key);
    if (group) group.count += 1;
  }
  return {
    total: snapshot.protocols.length,
    groups,
    ranked: rows.length,
    watchlist: snapshot.watchlist.length,
  };
}
