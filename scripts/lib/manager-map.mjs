// Resolves real-world people to a single stable identity across data
// sources that otherwise disagree on what to call them — Sleeper knows
// someone by their username/display name, an Excel sheet might use their
// first name, and either can change over time. `personId` is our own
// durable ID that both the Sleeper fetch script and the Excel importer
// translate into, so career stats/head-to-head merge correctly regardless
// of source.
//
// See data/manager-map.json for the actual mapping and README.md for how
// to fill it in.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, "..", "..", "data", "manager-map.json");

const norm = (s) => (s || "").trim().toLowerCase();

export async function loadManagerMap() {
  const raw = await readFile(MAP_PATH, "utf-8").catch(() => "[]");
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`  Couldn't parse ${MAP_PATH}; treating manager map as empty.`);
    return [];
  }
}

// Records each person's latest known Sleeper team name onto their
// manager-map entry (a `currentTeamName` field) and persists the file if
// anything changed. `updates` is an iterable of [personId, teamName] pairs.
// This is the write side of the "team names update everywhere automatically"
// behavior: every fetch-sleeper-data.mjs run refreshes this, and
// applyCurrentTeamNames() below is what then stamps it across every season.
export async function updateCurrentTeamNames(map, updates) {
  let changed = false;
  for (const [personId, teamName] of updates) {
    if (!personId || !teamName) continue;
    const entry = map.find((e) => e.personId === personId);
    if (entry && entry.currentTeamName !== teamName) {
      entry.currentTeamName = teamName;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf-8");
    console.log(`Updated current team name(s) in ${MAP_PATH}.`);
  }
  return changed;
}

// Overwrites `teamName` everywhere it appears in `seasons` — standings rows,
// champion/runnerUp, and both sides of every game — for any person who has a
// `currentTeamName` on file in the manager map. This is what makes every
// historical season (Excel-imported or old Sleeper seasons alike) display
// each manager's *current* Sleeper team name instead of whichever name was
// in effect back when that season was played or imported, and keeps it in
// sync automatically: re-running either script re-applies whatever the
// latest known name is.
export function applyCurrentTeamNames(seasons, map) {
  const nameByOwnerId = new Map(
    map.filter((e) => e.currentTeamName).map((e) => [e.personId, e.currentTeamName])
  );
  if (nameByOwnerId.size === 0) return seasons;

  const apply = (obj) => {
    if (obj && obj.ownerId && nameByOwnerId.has(obj.ownerId)) {
      obj.teamName = nameByOwnerId.get(obj.ownerId);
    }
  };

  for (const season of seasons) {
    for (const row of season.standings || []) apply(row);
    apply(season.champion);
    apply(season.runnerUp);
    for (const g of season.games || []) {
      apply(g.teamA);
      apply(g.teamB);
    }
  }
  return seasons;
}

// Look up a Sleeper account (by username and/or display name) in the map.
// Returns the matching entry, or null if this person hasn't been mapped yet.
export function resolveBySleeperIdentity(map, { username, displayName }) {
  const u = norm(username);
  const d = norm(displayName);
  return (
    map.find(
      (entry) =>
        (u && (entry.sleeperUsernames || []).some((s) => norm(s) === u)) ||
        (d && (entry.sleeperUsernames || []).some((s) => norm(s) === d))
    ) || null
  );
}

// Look up a name as it appears in the historical Excel sheet.
export function resolveByExcelName(map, name) {
  const n = norm(name);
  if (!n) return null;
  return map.find((entry) => (entry.excelNames || []).some((e) => norm(e) === n)) || null;
}
