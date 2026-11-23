// main.ts — the entry runner: model -> parent discount -> farm ->
// accounting -> integrity -> board.json / data.js / dossier.json.
//
// Node 22, standard library only, no network. The snapshot is read
// from --input / RADAR_INPUT (a file, or a directory holding
// snapshot.json); the outputs land in --output / RADAR_OUTPUT /
// MAKEFUN_OUTPUT_DIR. The run is deterministic: the same snapshot
// always yields the same bytes.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoardModel, looRatioPredictor } from "./lib/model.ts";
import type { BoardRow, Snapshot } from "./lib/model.ts";
import { addFarm } from "./lib/farm.ts";
import { buildAccounting } from "./lib/accounting.ts";
import { buildIntegrity } from "./lib/integrity.ts";
import {
  PARENT_FACTOR,
  PARENT_PRODUCTS,
  parentScale,
} from "./lib/parent.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

// Caps from the competition's kit: the dashboard's text (its own words,
// not the data) must stay under 64 KiB, at most 4 screenshots of at
// most 512 KiB each, and the dashboard as a whole under 4 MiB.
const TEXT_MAX_BYTES = 65536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4194304 };

// The entry directory is this script's own directory (or
// MAKEFUN_BOT_DIR when the harness sets it). dashboard/ and
// screenshots/ are resolved from there, never from process.cwd().
const ENTRY_DIR =
  process.env.MAKEFUN_BOT_DIR ??
  fileURLToPath(new URL(".", import.meta.url));
const DASHBOARD_DIR = join(ENTRY_DIR, "dashboard");
const SCREENSHOTS_DIR = join(ENTRY_DIR, "screenshots");

// Parse one "--name value" or "--name=value" argument, or undefined
// when the flag is absent. Both spellings are accepted so the harness
// and a human shell call can use whichever they prefer.
function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return undefined;
}

// Resolve the input: an explicit --input, else RADAR_INPUT, else the
// default. A directory means its snapshot.json.
function resolveInput(): string {
  const raw = argValue("--input") ?? process.env.RADAR_INPUT ?? "/input/snapshot.json";
  if (existsSync(raw) && statSync(raw).isDirectory()) return join(raw, "snapshot.json");
  return raw;
}

// Resolve the output directory: --output, else RADAR_OUTPUT, else
// MAKEFUN_OUTPUT_DIR, else /output.
function resolveOutput(): string {
  return (
    argValue("--output") ??
    process.env.RADAR_OUTPUT ??
    process.env.MAKEFUN_OUTPUT_DIR ??
    "/output"
  );
}

// Copy the regular files of one directory into another, skipping
// dot-files, and return how many were copied. Subdirectories are not
// copied — the dashboard and screenshots are flat by design.
function copyDirFlat(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  let count = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    count += 1;
  }
  return count;
}

function main(): void {
  const inputPath = resolveInput();
  const outputDir = resolveOutput();
  if (!existsSync(inputPath)) {
    console.error(`snapshot not found: ${inputPath}`);
    process.exit(2);
  }
  const snapshot = JSON.parse(
    readFileSync(inputPath, "utf-8"),
  ) as Snapshot;
  if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
    console.error(
      `snapshot ${inputPath} has no protocols/watchlist arrays`,
    );
    process.exit(2);
  }

  // Build the board, then discount the parent-product lines: each
  // caught row keeps 48% of its fitted value (and of every bound
  // derived from it), is tagged with the line's description, and the
  // board is re-ranked with $1 tie-nudges so implied values stay
  // strictly decreasing.
  const board = buildBoardModel(snapshot);
  const detected: { slug: string; name: string; parent: string }[] = [];
  const missing: string[] = [];
  const boardSlugs = new Set(board.rows.map((r) => r.slug));
  for (const slug of Object.keys(PARENT_PRODUCTS)) {
    const row = board.rows.find((r) => r.slug === slug);
    if (row) {
      detected.push({ slug, name: row.name, parent: PARENT_PRODUCTS[slug] });
    }
  }
  for (const slug of Object.keys(PARENT_PRODUCTS)) {
    if (!boardSlugs.has(slug)) missing.push(slug);
  }
  for (const row of board.rows as BoardRow[]) {
    const parent = PARENT_PRODUCTS[row.slug];
    if (parent === undefined) continue;
    row.parentFactor = PARENT_FACTOR;
    row.parentName = parent;
    row.impliedValueUsd = parentScale(row.impliedValueUsd);
    row.p25 = parentScale(row.p25);
    row.p75 = parentScale(row.p75);
    row.p10 = parentScale(row.p10);
    row.p90 = parentScale(row.p90);
    row.bootstrapLow = parentScale(row.bootstrapLow);
    row.bootstrapHigh = parentScale(row.bootstrapHigh);
  }
  board.rows.sort((a, b) => {
    if (b.impliedValueUsd !== a.impliedValueUsd)
      return b.impliedValueUsd - a.impliedValueUsd;
    if (b.tvlUsd !== a.tvlUsd) return b.tvlUsd - a.tvlUsd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 1; i < board.rows.length; i++) {
    if (board.rows[i].impliedValueUsd >= board.rows[i - 1].impliedValueUsd) {
      board.rows[i].impliedValueUsd = board.rows[i - 1].impliedValueUsd - 1;
    }
  }
  for (let i = 0; i < board.rows.length; i++) board.rows[i].rank = i + 1;

  // Farm economics, then the ledger and the integrity block.
  addFarm(board.rows, snapshot, looRatioPredictor());
  const accounting = buildAccounting(snapshot, board.rows);
  const integrity = buildIntegrity(board.rows, snapshot);
  const out = {
    ...board,
    floorUsd: snapshot.floor_usd,
    accounting,
    integrity,
  };

  // Write the board: board.json pretty-printed with a trailing
  // newline, and data.js as the same JSON wrapped in window.RADAR.
  mkdirSync(outputDir, { recursive: true });
  const json = JSON.stringify(out, null, 2);
  writeFileSync(join(outputDir, "board.json"), json + "\n", "utf-8");
  writeFileSync(join(outputDir, "data.js"), `window.RADAR = ${json};\n`, "utf-8");

  // Copy the dashboard and the screenshots into the output, then build
  // the dossier from them — but only when at least one screenshot was
  // copied; without screenshots there is nothing to dossier.
  const dashboardOut = join(outputDir, "dashboard");
  const screenshotsOut = join(outputDir, "screenshots");
  mkdirSync(dashboardOut, { recursive: true });
  mkdirSync(screenshotsOut, { recursive: true });
  const dashboardCount = copyDirFlat(DASHBOARD_DIR, dashboardOut);
  const screenshotCount = copyDirFlat(SCREENSHOTS_DIR, screenshotsOut);
  let dossierWritten = false;
  if (screenshotCount === 0) {
    console.error("warning: no screenshots copied; skipping dossier.json");
  } else {
    // buildDossier returns the dossier as canonical JSON bytes; the
    // runner writes them to dossier.json itself.
    const dossierBytes = buildDossier(outputDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    });
    writeFileSync(join(outputDir, "dossier.json"), dossierBytes);
    dossierWritten = true;
  }

  // Run log: counts, rank 1, the parent lines caught, and the files
  // written. Every number here comes from this run, not from memory.
  const covered = board.rows.filter((r) => r.watchlist).length;
  const rank1 = board.rows[0];
  console.log(`protocols: ${snapshot.protocols.length}`);
  console.log(`watchlist: ${snapshot.watchlist.length}`);
  console.log(`rows: ${board.rows.length} (${covered}/${snapshot.watchlist.length} watchlist covered)`);
  if (rank1) {
    console.log(`rank 1: ${rank1.name} $${rank1.impliedValueUsd.toLocaleString("en-US")}`);
  }
  console.log(
    `parent rows x${PARENT_FACTOR}: ${detected.length}` +
      (detected.length > 0
        ? ` (${detected.map((d) => `${d.slug} (${d.parent})`).join(", ")})`
        : ""),
  );
  if (missing.length > 0) {
    console.log(`parent slugs with no row: ${missing.join(", ")}`);
  }
  console.log(
    `wrote: board.json, data.js, ${dashboardCount} dashboard files, ${screenshotCount} screenshots` +
      (dossierWritten ? ", dossier.json" : " (no dossier)"),
  );
}

main();
