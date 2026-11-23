// lib/integrity.ts — checksum and ledger counts.
//
// Proves the board on screen is the board that was computed: the
// dashboard recomputes these same six numbers in the browser from the
// data file itself, including the FNV-1a checksum of the ranked rows.
// If any row were edited after the run, the checksum would stop matching.

export interface IntegrityRow {
  slug: string;
  rank: number;
  impliedValueUsd: number;
  watchlist?: boolean;
}

export interface IntegritySnapshot {
  protocols: unknown[];
  watchlist: string[];
}

export interface Integrity {
  checksum: string;
  totalImplied: number;
  watchlistCovered: number;
  watchlistTotal: number;
  ledgerTotal: number;
  rows: number;
}

// 32-bit FNV-1a over the UTF-8 bytes of a string, returned as eight
// lowercase hex digits. Check values: fnv1a("") is "811c9dc5" and
// fnv1a("a") is "e40c292c". This is a DIFFERENT function from the
// number-returning fnv1a in lib/range.ts (UTF-16 code units, numeric
// result, used for seeding) — keep both, do not merge them.
export function fnv1a(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = hash ^ bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The exact text the checksum is taken over: one line per row, in rank
// order, "slug|rank|impliedValueUsd" with the implied value written in
// JavaScript's default number-to-string form, lines joined by "\n" with
// no trailing newline. Any change to a slug, a rank or a value changes
// the checksum.
export function checksumInput(rows: IntegrityRow[]): string {
  const ordered = rows.slice().sort((a, b) => a.rank - b.rank);
  return ordered
    .map((r) => `${r.slug}|${r.rank}|${r.impliedValueUsd}`)
    .join("\n");
}

// Build the integrity block for a finished board. The total is rounded
// to cents; the watchlist counts come from the snapshot's own list, so a
// missing watchlist row would show up here as watchlistCovered <
// watchlistTotal, and a stray row would show up as rows > ledgerTotal.
export function buildIntegrity(
  rows: IntegrityRow[],
  snapshot: IntegritySnapshot,
): Integrity {
  const watchlist = new Set(snapshot.watchlist);
  let covered = 0;
  for (const row of rows) {
    if (watchlist.has(row.slug)) covered += 1;
  }
  let total = 0;
  for (const row of rows) total += row.impliedValueUsd;
  return {
    checksum: fnv1a(checksumInput(rows)),
    totalImplied: Math.round(total * 100) / 100,
    watchlistCovered: covered,
    watchlistTotal: snapshot.watchlist.length,
    ledgerTotal: snapshot.protocols.length,
    rows: rows.length,
  };
}
