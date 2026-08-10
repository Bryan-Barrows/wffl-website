#!/usr/bin/env node
/**
 * import-excel-history.mjs
 *
 * Imports the league's historical spreadsheet into data/league-data.json as
 * "source": "excel" seasons, alongside whatever Sleeper has already fetched.
 *
 * Expects three sheets (exact names):
 *  - "Owners": Owner Name | Sleeper Username
 *      Current managers mapped to their Sleeper identity.
 *  - "Season Data": Year | Team | Place
 *      Final standing (1 = champion, 2 = runner-up, 3/4 = 3rd place game,
 *      5+ = regular-season order among non-playoff teams) per owner per year.
 *  - "Player Data": Owner | Opponent | Year | Week | Points For | Points Against |
 *                   Win | Loss | Tie | 1st | 2nd | 3rd | 4th | Champ. Pts | Playoffs | Luck
 *      One row per team per game — every game appears twice, once per side.
 *      "Week" is a number for the regular season, or one of "Quarters" /
 *      "Semis" / "3rd Place" / "Championship" for the playoffs.
 *
 * Design decisions (see conversation for the full reasoning):
 *  - Regular-season win/loss/points (the standings columns) come only from
 *    numbered weeks, excluding playoff games — the same convention Sleeper
 *    itself uses for its roster win/loss records.
 *  - `rank` comes directly from Season Data's "Place", which is playoff-aware
 *    (unlike a plain win/loss sort) — this is the authoritative final standing.
 *  - Games are paired primarily by matching Owner/Opponent name in both
 *    directions; a handful of rows have a typo'd Opponent name, so as a
 *    fallback, games in the same year/week are paired by matching scores
 *    instead (row A's "Points For" equals row B's "Points Against" and vice
 *    versa). Either way, each side's own self-reported "Points For" is used
 *    as that side's score — never the (occasionally slightly inconsistent)
 *    "Points Against" reported by the other side.
 *  - Excel-imported seasons are treated as the authoritative historical
 *    record: this script's output takes priority over Sleeper for any
 *    overlapping year (see main()'s merge with the existing data file).
 *
 * Usage: node scripts/import-excel-history.mjs [path/to/file.xlsx]
 * Defaults to data/source/wffl_raw.xlsx.
 *
 * Requires the `xlsx` package: run `npm install` once before using this.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { computeAggregates } from "./lib/aggregate.mjs";
import { loadManagerMap, resolveByExcelName } from "./lib/manager-map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "league-data.json");
const MANAGER_MAP_PATH = path.join(__dirname, "..", "data", "manager-map.json");
const DEFAULT_XLSX_PATH = path.join(__dirname, "..", "data", "source", "wffl_raw.xlsx");

// Playoff round labels -> week offset past that season's own last numbered
// regular-season week. Championship and 3rd Place happen in parallel, so
// they share a week number, same as how Sleeper numbers its playoff weeks.
const PLAYOFF_ROUND_OFFSETS = { Quarters: 1, Semis: 2, Championship: 3, "3rd Place": 3 };

function loadSheet(workbook, name) {
  const sheet = workbook.Sheets[name];
  if (!sheet) {
    throw new Error(`Sheet "${name}" not found. Sheets present: ${workbook.SheetNames.join(", ")}`);
  }
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

// Adds/updates data/manager-map.json from the Owners sheet, plus any owner
// names found in Player Data that aren't in Owners (departed managers who
// never had a Sleeper account). Idempotent: re-running with the same or an
// updated spreadsheet reuses existing personIds rather than minting new ones.
async function updateManagerMap(ownersRows, extraOwnerNames) {
  const map = await loadManagerMap();
  let nextIdNum = map.reduce((max, e) => {
    const n = parseInt(String(e.personId).replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);

  function findOrCreate(excelName, sleeperUsername) {
    let entry = resolveByExcelName(map, excelName);
    if (!entry && sleeperUsername) {
      entry = map.find((e) => (e.sleeperUsernames || []).some((u) => u.toLowerCase() === sleeperUsername.toLowerCase()));
    }
    if (!entry) {
      nextIdNum += 1;
      entry = { personId: `p${nextIdNum}`, canonicalName: excelName, sleeperUsernames: [], excelNames: [] };
      map.push(entry);
    }
    if (!entry.excelNames.includes(excelName)) entry.excelNames.push(excelName);
    if (sleeperUsername && !entry.sleeperUsernames.includes(sleeperUsername)) entry.sleeperUsernames.push(sleeperUsername);
    return entry;
  }

  for (const row of ownersRows) {
    const excelName = row["Owner Name"];
    if (!excelName) continue;
    findOrCreate(excelName, row["Sleeper Username"] || null);
  }
  for (const name of extraOwnerNames) {
    findOrCreate(name, null);
  }

  await writeFile(MANAGER_MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf-8");
  console.log(`Updated ${MANAGER_MAP_PATH} (${map.length} manager(s) total).`);
  return map;
}

function personFor(map, excelName) {
  const entry = resolveByExcelName(map, excelName);
  if (!entry) throw new Error(`No manager-map entry for Excel owner "${excelName}" (updateManagerMap should have created one).`);
  return { ownerId: entry.personId, managerName: entry.canonicalName };
}

// Finds the other row representing the same game. Tries the stated
// Owner/Opponent names first; falls back to matching by score within the
// same week, for the rare row with a typo'd Opponent name.
function findMirror(row, yearRows) {
  const exact = yearRows.find((r) => r.Owner === row.Opponent && r.Opponent === row.Owner && r.Week === row.Week);
  if (exact) return exact;
  return (
    yearRows.find(
      (r) =>
        r.Week === row.Week &&
        r.Owner !== row.Owner &&
        Math.abs(r["Points For"] - row["Points Against"]) < 0.05 &&
        Math.abs(r["Points Against"] - row["Points For"]) < 0.05
    ) || null
  );
}

function buildSeasons(playerRows, seasonRows, map) {
  const years = [...new Set(playerRows.map((r) => r.Year))].sort((a, b) => a - b);
  const seasons = [];

  for (const year of years) {
    const yearRows = playerRows.filter((r) => r.Year === year);
    const maxRegularWeek = Math.max(0, ...yearRows.filter((r) => typeof r.Week === "number").map((r) => r.Week));

    function weekNumber(rawWeek) {
      if (typeof rawWeek === "number") return rawWeek;
      const offset = PLAYOFF_ROUND_OFFSETS[rawWeek];
      if (offset == null) throw new Error(`Unrecognized Week label "${rawWeek}" in year ${year}`);
      return maxRegularWeek + offset;
    }

    const games = [];
    const seen = new Set();
    for (const row of yearRows) {
      const mirror = findMirror(row, yearRows);
      if (!mirror) {
        console.warn(`  ${year}, week ${row.Week}: no opponent match found for ${row.Owner} — skipping this row.`);
        continue;
      }
      const dedupeKey = [row.Owner, mirror.Owner].sort().join("|") + `|${row.Week}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const personA = personFor(map, row.Owner);
      const personB = personFor(map, mirror.Owner);
      games.push({
        week: weekNumber(row.Week),
        isPlayoff: typeof row.Week !== "number",
        teamA: { ownerId: personA.ownerId, teamName: personA.managerName, score: Number(row["Points For"]) },
        teamB: { ownerId: personB.ownerId, teamName: personB.managerName, score: Number(mirror["Points For"]) },
      });
    }

    // Regular-season standings: aggregate each owner's own numbered-week rows only.
    const owners = [...new Set(yearRows.map((r) => r.Owner))];
    const standingsByOwner = new Map();
    for (const owner of owners) {
      const rows = yearRows.filter((r) => r.Owner === owner && typeof r.Week === "number");
      const person = personFor(map, owner);
      standingsByOwner.set(owner, {
        ownerId: person.ownerId,
        managerName: person.managerName,
        teamName: person.managerName,
        wins: rows.reduce((s, r) => s + (r.Win || 0), 0),
        losses: rows.reduce((s, r) => s + (r.Loss || 0), 0),
        ties: rows.reduce((s, r) => s + (r.Tie || 0), 0),
        pointsFor: Number(rows.reduce((s, r) => s + (r["Points For"] || 0), 0).toFixed(2)),
        pointsAgainst: Number(rows.reduce((s, r) => s + (r["Points Against"] || 0), 0).toFixed(2)),
        rank: null,
      });
    }

    // Rank/placement from Season Data's authoritative "Place" (playoff-aware).
    for (const pr of seasonRows.filter((r) => r.Year === year)) {
      const s = standingsByOwner.get(pr.Team);
      if (s) s.rank = pr.Place;
      else console.warn(`  ${year}: Season Data lists "${pr.Team}" but no matching rows in Player Data.`);
    }

    const standings = [...standingsByOwner.values()].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    const champion = standings.find((s) => s.rank === 1);
    const runnerUp = standings.find((s) => s.rank === 2);

    seasons.push({
      year,
      leagueId: null,
      status: "complete",
      name: `WFFL ${year}`,
      source: "excel",
      standings,
      champion: champion ? { ownerId: champion.ownerId, managerName: champion.managerName, teamName: champion.teamName } : null,
      runnerUp: runnerUp ? { ownerId: runnerUp.ownerId, managerName: runnerUp.managerName, teamName: runnerUp.teamName } : null,
      games,
      settings: null,
      previousLeagueId: null,
    });
  }

  return seasons;
}

async function main() {
  const xlsxPath = process.argv[2] || DEFAULT_XLSX_PATH;
  console.log(`Reading ${xlsxPath}...`);
  const buf = await readFile(xlsxPath);
  const workbook = XLSX.read(buf, { type: "buffer" });

  const ownersRows = loadSheet(workbook, "Owners");
  const seasonRows = loadSheet(workbook, "Season Data");
  const playerRows = loadSheet(workbook, "Player Data");

  const ownersInSheet = new Set(ownersRows.map((r) => r["Owner Name"]));
  const extraOwnerNames = [...new Set(playerRows.map((r) => r.Owner))].filter((n) => !ownersInSheet.has(n));
  if (extraOwnerNames.length > 0) {
    console.log(`Found owner name(s) not in the Owners sheet (likely departed managers, no Sleeper account): ${extraOwnerNames.join(", ")}`);
  }

  const map = await updateManagerMap(ownersRows, extraOwnerNames);

  const excelSeasons = buildSeasons(playerRows, seasonRows, map);
  console.log(`Parsed ${excelSeasons.length} season(s) from Excel: ${excelSeasons.map((s) => s.year).join(", ")}`);

  const existingRaw = await readFile(DATA_PATH, "utf-8").catch(() => null);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  // Excel is the authoritative historical record: it wins over whatever's
  // already there (Sleeper, or a previous import) for any year it covers.
  // Any leftover fabricated sample season is dropped outright rather than
  // kept — it's not real data, and showing it (e.g. a placeholder "upcoming
  // season" with made-up team names) next to real history would be worse
  // than just not having that season yet.
  const excelYears = new Set(excelSeasons.map((s) => s.year));
  const keptOtherSeasons = (existing.seasons || []).filter((s) => !excelYears.has(s.year) && s.source !== "sample");
  const allSeasons = [...excelSeasons, ...keptOtherSeasons].sort((a, b) => b.year - a.year);

  const allTime = computeAggregates(allSeasons);

  // Everything fabricated by the sample-data generator (logo, constitution
  // text, weekly awards, draft info) references sample manager IDs that no
  // longer exist once real seasons replace the sample ones — carrying it
  // forward would show fake content next to real data. Wipe it the first
  // time real data lands; anything genuinely real (set after isSampleData
  // was already false) is preserved as usual.
  const wasSample = !!existing.isSampleData;

  const output = {
    ...existing,
    leagueName: existing.leagueName || "Whippany Fantasy Football League (WFFL)",
    isSampleData: false,
    lastUpdated: new Date().toISOString(),
    seasons: allSeasons,
    allTime,
    logoPath: wasSample ? null : existing.logoPath || null,
    constitutionText: wasSample ? null : existing.constitutionText || null,
    constitutionUpdates: wasSample ? null : existing.constitutionUpdates || null,
    weeklyAwards: wasSample ? null : existing.weeklyAwards || null,
    draftCentral: wasSample ? null : existing.draftCentral || null,
  };

  await writeFile(DATA_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${allSeasons.length} total season(s) to ${DATA_PATH} (${excelSeasons.length} from this Excel import).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
