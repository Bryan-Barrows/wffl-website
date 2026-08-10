#!/usr/bin/env node
/**
 * fetch-sleeper-data.mjs
 *
 * Pulls league history, standings, champions, and week-by-week matchups from
 * the Sleeper public API and writes the result to data/league-data.json for
 * the static site to read.
 *
 * Sleeper's API is public and requires no auth key. Docs: https://docs.sleeper.com/
 *
 * Usage:
 *   node scripts/fetch-sleeper-data.mjs [currentLeagueId]
 *
 * If no league ID is passed, it reads currentLeagueId out of the existing
 * data/league-data.json so re-runs don't require re-typing it.
 *
 * Note: Sleeper only has data for seasons your league actually played on
 * Sleeper. Earlier seasons on another platform won't show up here — add
 * those by hand to data/league-data.json with "source": "manual" (or import
 * them via a script like scripts/import-excel-history.mjs); this script
 * preserves any non-Sleeper-sourced season it finds already in the file.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAggregates, computeWeekAwards } from "./lib/aggregate.mjs";
import { loadManagerMap, resolveBySleeperIdentity } from "./lib/manager-map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "league-data.json");
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const API_BASE = "https://api.sleeper.app/v1";
const AVATAR_CDN = "https://sleepercdn.com/avatars";
const MAX_WEEKS_TO_CHECK = 18; // generous upper bound; Sleeper returns empty for weeks that never happened

async function sleeperGet(pathSuffix) {
  const url = `${API_BASE}${pathSuffix}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Sleeper API error ${res.status} for ${url}`);
  }
  return res.json();
}

// Downloads the league's Sleeper avatar (its "logo") into assets/ and returns
// a site-relative path to reference it, or null if there's no avatar or the
// download fails for any reason (never fatal — the site just falls back to
// its default header icon).
async function downloadLeagueLogo(avatarHash) {
  if (!avatarHash) return null;
  try {
    const res = await fetch(`${AVATAR_CDN}/${avatarHash}`);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const filename = `league-logo.${ext}`;
    const buffer = Buffer.from(await res.arrayBuffer());
    await mkdir(ASSETS_DIR, { recursive: true });
    await writeFile(path.join(ASSETS_DIR, filename), buffer);
    return `assets/${filename}`;
  } catch (err) {
    console.warn(`  Failed to download league logo: ${err.message}`);
    return null;
  }
}

function teamNameFor(user) {
  return (
    user?.metadata?.team_name?.trim() ||
    user?.display_name ||
    `Manager ${user?.user_id ?? "Unknown"}`
  );
}

// Resolves a Sleeper user to our stable cross-source identity via
// data/manager-map.json. Falls back to Sleeper's own user_id/display_name
// (and warns) for anyone not yet in the map, so the pipeline never breaks —
// it just can't merge that person's history until they're mapped.
function resolvePerson(managerMap, user) {
  if (!user) return { ownerId: null, managerName: "Unknown" };
  const match = resolveBySleeperIdentity(managerMap, { username: user.username, displayName: user.display_name });
  if (match) return { ownerId: match.personId, managerName: match.canonicalName };
  console.warn(
    `  No manager-map entry for Sleeper user "${user.display_name}" (username: ${user.username}, user_id: ${user.user_id}) — ` +
      `using their raw Sleeper identity for now. Add them to data/manager-map.json to merge with historical data.`
  );
  return { ownerId: user.user_id, managerName: user.display_name || "Unknown" };
}

async function fetchGames(leagueId, rosterMeta, playoffWeekStart) {
  const games = [];
  for (let week = 1; week <= MAX_WEEKS_TO_CHECK; week++) {
    let matchups;
    try {
      matchups = await sleeperGet(`/league/${leagueId}/matchups/${week}`);
    } catch (err) {
      console.warn(`  Failed to fetch matchups for week ${week}: ${err.message}`);
      continue;
    }
    if (!matchups || matchups.length === 0) continue;

    const byMatchupId = new Map();
    for (const m of matchups) {
      if (m.matchup_id == null) continue; // no opponent assigned (bye)
      if (!byMatchupId.has(m.matchup_id)) byMatchupId.set(m.matchup_id, []);
      byMatchupId.get(m.matchup_id).push(m);
    }

    for (const pair of byMatchupId.values()) {
      if (pair.length !== 2) continue; // skip byes / malformed groups
      const [m1, m2] = pair;
      const meta1 = rosterMeta.get(m1.roster_id);
      const meta2 = rosterMeta.get(m2.roster_id);
      games.push({
        week,
        isPlayoff: playoffWeekStart ? week >= playoffWeekStart : false,
        teamA: { ownerId: meta1?.ownerId ?? null, teamName: meta1?.teamName ?? "Unknown", score: Number((m1.points || 0).toFixed(2)) },
        teamB: { ownerId: meta2?.ownerId ?? null, teamName: meta2?.teamName ?? "Unknown", score: Number((m2.points || 0).toFixed(2)) },
      });
    }
  }
  return games;
}

// Sleeper's full NFL player directory (~5MB, every player who's ever been
// rostered). There's no per-player lookup endpoint, so resolving even one
// player's name requires fetching this whole thing. Sleeper's docs ask that
// it not be called more than once a day — fine here since we only call it
// once per script run, and the scheduled Action runs at most a few times/day.
async function fetchPlayersDict() {
  try {
    return await sleeperGet("/players/nfl");
  } catch (err) {
    console.warn(`  Failed to fetch the NFL players directory (top-player award will be skipped): ${err.message}`);
    return null;
  }
}

// Finds the single highest-scoring starter league-wide for one week, for the
// "top player performance" weekly award. Uses each matchup's starters/
// starters_points arrays (index-aligned) rather than players_points, since
// that's specifically the starting lineup rather than the whole bench.
async function fetchTopPlayerPerformance(leagueId, week, rosterMeta, playersById) {
  if (!playersById) return null;
  let matchups;
  try {
    matchups = await sleeperGet(`/league/${leagueId}/matchups/${week}`);
  } catch (err) {
    console.warn(`  Failed to fetch matchups for the top-player award (week ${week}): ${err.message}`);
    return null;
  }
  if (!matchups || matchups.length === 0) return null;

  let best = null;
  for (const m of matchups) {
    const starters = m.starters || [];
    const starterPoints = m.starters_points || [];
    const meta = rosterMeta.get(m.roster_id);
    starters.forEach((playerId, i) => {
      if (!playerId || playerId === "0") return; // empty roster slot
      const points = starterPoints[i];
      if (typeof points !== "number") return;
      if (!best || points > best.points) {
        const player = playersById[playerId];
        const playerName =
          player?.full_name || `${player?.first_name || ""} ${player?.last_name || ""}`.trim() || `Player ${playerId}`;
        best = {
          playerId,
          playerName,
          position: player?.position || null,
          nflTeam: player?.team || null,
          points: Number(points.toFixed(2)),
          fantasyTeamName: meta?.teamName ?? "Unknown",
          fantasyOwnerId: meta?.ownerId ?? null,
        };
      }
    });
  }
  return best;
}

async function fetchSeason(leagueId, managerMap) {
  const league = await sleeperGet(`/league/${leagueId}`);
  if (!league) return null;

  const [users, rosters, winnersBracket] = await Promise.all([
    sleeperGet(`/league/${leagueId}/users`),
    sleeperGet(`/league/${leagueId}/rosters`),
    sleeperGet(`/league/${leagueId}/winners_bracket`),
  ]);

  const usersById = new Map((users || []).map((u) => [u.user_id, u]));

  const rosterMeta = new Map(
    (rosters || []).map((r) => {
      const user = usersById.get(r.owner_id);
      const person = resolvePerson(managerMap, user);
      return [r.roster_id, { ownerId: person.ownerId, managerName: person.managerName, teamName: teamNameFor(user) }];
    })
  );

  // Same identity info as rosterMeta, but keyed by Sleeper user_id instead of
  // roster_id — the draft endpoints (draft_order) key by user_id, not roster_id.
  const ownerMetaByUserId = new Map((rosters || []).map((r) => [r.owner_id, rosterMeta.get(r.roster_id)]));

  const standings = (rosters || [])
    .map((r) => {
      const meta = rosterMeta.get(r.roster_id);
      const s = r.settings || {};
      const fpts = (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
      const fptsAgainst = (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100;
      return {
        rosterId: r.roster_id,
        ownerId: meta.ownerId,
        managerName: meta.managerName,
        teamName: meta.teamName,
        wins: s.wins || 0,
        losses: s.losses || 0,
        ties: s.ties || 0,
        pointsFor: Number(fpts.toFixed(2)),
        pointsAgainst: Number(fptsAgainst.toFixed(2)),
      };
    })
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.pointsFor - a.pointsFor;
    })
    .map((row, i) => ({ ...row, rank: i + 1 }));

  // Find champion / runner-up from the winners bracket's final placement match (p: 1).
  let champion = null;
  let runnerUp = null;
  if (Array.isArray(winnersBracket)) {
    const finalMatch = winnersBracket.find((m) => m.p === 1);
    if (finalMatch && finalMatch.w != null) {
      const winnerRoster = standings.find((r) => r.rosterId === finalMatch.w);
      const loserRoster = standings.find((r) => r.rosterId === finalMatch.l);
      champion = winnerRoster
        ? { teamName: winnerRoster.teamName, managerName: winnerRoster.managerName, ownerId: winnerRoster.ownerId }
        : null;
      runnerUp = loserRoster
        ? { teamName: loserRoster.teamName, managerName: loserRoster.managerName, ownerId: loserRoster.ownerId }
        : null;
    }
  }

  const playoffWeekStart = league.settings?.playoff_week_start || null;
  const games = await fetchGames(leagueId, rosterMeta, playoffWeekStart);

  const season = {
    year: Number(league.season),
    leagueId,
    status: league.status, // 'pre_draft' | 'drafting' | 'in_season' | 'complete'
    name: league.name,
    avatar: league.avatar || null,
    source: "sleeper",
    standings,
    champion,
    runnerUp,
    games,
    settings: {
      numTeams: league.settings?.num_teams ?? standings.length,
      playoffWeekStart,
      playoffTeams: league.settings?.playoff_teams ?? null,
      rosterPositions: league.roster_positions ?? null,
      scoringSettings: league.scoring_settings ?? null,
    },
    previousLeagueId: league.previous_league_id || null,
  };

  // rosterMeta/ownerMetaByUserId are returned alongside (not persisted as
  // part of the season object itself) so main() can reuse them for the
  // current league's weekly awards and draft info without redundant fetches.
  return { season, rosterMeta, ownerMetaByUserId };
}

// Pulls the current/upcoming draft: countdown target, draft order, and any
// traded picks affecting it. Keepers have no equivalent in Sleeper's API —
// those stay purely manual, merged in by the caller.
async function fetchDraftCentral(leagueId, rosterMeta, ownerMetaByUserId, year) {
  let drafts;
  try {
    drafts = await sleeperGet(`/league/${leagueId}/drafts`);
  } catch (err) {
    console.warn(`  Failed to fetch drafts for league ${leagueId}: ${err.message}`);
    return null;
  }
  if (!drafts || drafts.length === 0) return null;

  const draft = drafts[0]; // leagues normally have exactly one draft per season
  if (!draft) return null;

  let draftOrder = [];
  if (draft.draft_order) {
    draftOrder = Object.entries(draft.draft_order)
      .map(([userId, pick]) => {
        const meta = ownerMetaByUserId.get(userId);
        return { pick, ownerId: meta?.ownerId ?? null, teamName: meta?.teamName ?? "Unknown", managerName: meta?.managerName ?? "Unknown" };
      })
      .sort((a, b) => a.pick - b.pick);
  }

  let tradedPicks = [];
  try {
    const raw = await sleeperGet(`/league/${leagueId}/traded_picks`);
    tradedPicks = (raw || [])
      .filter((p) => String(p.season) === String(year))
      .map((p) => {
        const original = rosterMeta.get(p.roster_id);
        const current = rosterMeta.get(p.owner_id);
        const previous = rosterMeta.get(p.previous_owner_id);
        return {
          round: p.round,
          season: p.season,
          originalTeamName: original?.teamName ?? "Unknown",
          originalOwnerId: original?.ownerId ?? null,
          currentTeamName: current?.teamName ?? "Unknown",
          currentOwnerId: current?.ownerId ?? null,
          previousTeamName: previous?.teamName ?? "Unknown",
          previousOwnerId: previous?.ownerId ?? null,
        };
      })
      .sort((a, b) => a.round - b.round);
  } catch (err) {
    console.warn(`  Failed to fetch traded picks: ${err.message}`);
  }

  return {
    year,
    draftId: draft.draft_id,
    status: draft.status, // 'pre_draft' | 'drafting' | 'complete'
    startTime: draft.start_time ? new Date(draft.start_time).toISOString() : null,
    draftOrder,
    tradedPicks,
  };
}

async function main() {
  const existingRaw = await readFile(DATA_PATH, "utf-8").catch(() => null);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const startLeagueId = process.argv[2] || existing.currentLeagueId;
  if (!startLeagueId) {
    console.error(
      "No league ID provided and none found in data/league-data.json (currentLeagueId). " +
        "Pass one: node scripts/fetch-sleeper-data.mjs <leagueId>"
    );
    process.exit(1);
  }

  const managerMap = await loadManagerMap();
  if (managerMap.length === 0) {
    console.warn(
      "  data/manager-map.json is empty — every Sleeper manager will show up under their raw Sleeper " +
        "identity, and historical (Excel-imported) seasons won't merge with them. Fill in the map when ready."
    );
  }

  console.log(`Starting from league ${startLeagueId}, walking history backward...`);

  const seasons = [];
  let currentRosterMeta = null; // rosterMeta/ownerMetaByUserId for startLeagueId specifically, captured below
  let currentOwnerMetaByUserId = null;
  let cursor = startLeagueId;
  const seen = new Set();

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    console.log(`Fetching season for league ${cursor}...`);
    let result;
    try {
      result = await fetchSeason(cursor, managerMap);
    } catch (err) {
      console.error(`  Failed to fetch league ${cursor}: ${err.message}. Stopping walk here.`);
      break;
    }
    if (!result) {
      console.warn(`  League ${cursor} not found. Stopping walk here.`);
      break;
    }
    const { season, rosterMeta, ownerMetaByUserId } = result;
    if (cursor === startLeagueId) {
      currentRosterMeta = rosterMeta;
      currentOwnerMetaByUserId = ownerMetaByUserId;
    }
    console.log(`  Season ${season.year}: ${season.standings.length} teams, ${season.games.length} games found.`);
    seasons.push(season);
    cursor = season.previousLeagueId;
  }

  if (seasons.length === 0) {
    console.error(
      `Fetched zero seasons from Sleeper for league ${startLeagueId} — refusing to overwrite ` +
        `${DATA_PATH} (it would wipe out or mislabel whatever data is already there). Check the ` +
        "league ID and network access, then try again."
    );
    process.exit(1);
  }

  seasons.sort((a, b) => b.year - a.year);

  // Manually/Excel-imported historical seasons are the authoritative record
  // (they capture true final placement including playoffs, which Sleeper's
  // regular-season-only roster stats don't) — they win over Sleeper for any
  // year they cover. Sleeper only fills in years the import doesn't have,
  // which in practice means the current/upcoming season.
  const manualSeasons = (existing.seasons || []).filter((s) => s.source !== "sleeper");
  const manualYears = new Set(manualSeasons.map((s) => s.year));
  const keptSleeperSeasons = seasons.filter((s) => !manualYears.has(s.year));

  const allSeasons = [...manualSeasons, ...keptSleeperSeasons].sort((a, b) => b.year - a.year);
  const allTime = computeAggregates(allSeasons);

  // Use the most current Sleeper season's avatar as the site logo.
  const currentSeason = seasons.find((s) => s.leagueId === startLeagueId);
  const logoPath = await downloadLeagueLogo(currentSeason?.avatar);

  // Weekly awards (most/fewest points, biggest margin, top individual
  // player performance) for the most recently completed week of the
  // current season. Never fatal if any part of this fails — we just fall
  // back to whatever was there before, so a bad week doesn't blank the
  // homepage section that only meaningfully changes once a week anyway.
  let weeklyAwards = null;
  if (currentSeason && currentSeason.games.length > 0 && currentRosterMeta) {
    try {
      const latestWeek = Math.max(...currentSeason.games.map((g) => g.week));
      const teamAwards = computeWeekAwards(currentSeason.games, latestWeek);
      if (teamAwards) {
        const playersById = await fetchPlayersDict();
        const topPlayer = await fetchTopPlayerPerformance(startLeagueId, latestWeek, currentRosterMeta, playersById);
        weeklyAwards = { year: currentSeason.year, ...teamAwards, topPlayer };
      }
    } catch (err) {
      console.warn(`  Failed to compute weekly awards: ${err.message}`);
    }
  }

  // Draft Central: countdown/order/traded-picks come from Sleeper; keepers
  // are purely manual and simply carried forward from whatever was there.
  let draftCentral = existing.draftCentral || null;
  if (currentSeason && currentRosterMeta && currentOwnerMetaByUserId) {
    try {
      const fetched = await fetchDraftCentral(startLeagueId, currentRosterMeta, currentOwnerMetaByUserId, currentSeason.year);
      if (fetched) {
        draftCentral = { ...fetched, keepers: existing.draftCentral?.keepers || [] };
      }
    } catch (err) {
      console.warn(`  Failed to fetch Draft Central data: ${err.message}`);
    }
  }

  const output = {
    leagueName: existing.leagueName || "Fantasy Football League",
    platform: "sleeper",
    currentLeagueId: startLeagueId,
    isSampleData: false,
    lastUpdated: new Date().toISOString(),
    seasons: allSeasons,
    constitutionText: existing.constitutionText || null,
    constitutionUpdates: existing.constitutionUpdates || null,
    logoPath: logoPath || existing.logoPath || null,
    weeklyAwards: weeklyAwards || existing.weeklyAwards || null,
    draftCentral,
    allTime,
    notes: existing.notes || [],
  };

  await writeFile(DATA_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${allSeasons.length} season(s) to ${DATA_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
