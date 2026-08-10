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

import { readFile } from "node:fs/promises";
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
