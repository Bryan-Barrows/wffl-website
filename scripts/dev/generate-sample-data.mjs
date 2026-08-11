#!/usr/bin/env node
/**
 * generate-sample-data.mjs (DEV TOOL — not part of the production pipeline)
 *
 * Fabricates a realistic-looking multi-year league (2012–2025, plus an
 * upcoming 2026 pre-draft season) with full game-by-game results, so every
 * page of the site has something real to render while we wait on real
 * Sleeper/Excel data. Writes over data/league-data.json and sets
 * "isSampleData": true so the site shows a banner making that obvious.
 *
 * Deterministic (seeded RNG) so re-running produces the same output.
 *
 * Usage: node scripts/dev/generate-sample-data.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAggregates, computeWeekAwards } from "../lib/aggregate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "..", "data", "league-data.json");

const MANAGERS = [
  { ownerId: "m1", managerName: "Alex", teamName: "Gridiron Gang" },
  { ownerId: "m2", managerName: "Sam", teamName: "Turf Titans" },
  { ownerId: "m3", managerName: "Jordan", teamName: "End Zone Elite" },
  { ownerId: "m4", managerName: "Casey", teamName: "Blitz Brigade" },
  { ownerId: "m5", managerName: "Morgan", teamName: "Red Zone Raiders" },
  { ownerId: "m6", managerName: "Taylor", teamName: "Hail Mary Heroes" },
  { ownerId: "m7", managerName: "Riley", teamName: "Pigskin Prophets" },
  { ownerId: "m8", managerName: "Jamie", teamName: "Fumble Dynasty" },
  { ownerId: "m9", managerName: "Drew", teamName: "Sack Attack" },
  { ownerId: "m10", managerName: "Cameron", teamName: "Punt Return Kings" },
  { ownerId: "m11", managerName: "Quinn", teamName: "Field Goal Fanatics" },
  { ownerId: "m12", managerName: "Avery", teamName: "Two-Point Terrors" },
];

// A tiny inline placeholder "W" emblem so the site header can be previewed
// with a real logo image in place, before the actual Sleeper avatar is wired
// up. Encoded as a data URI so no binary asset file is needed for this.
const SAMPLE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath></defs>
  <circle cx="32" cy="32" r="31" fill="#f5f7fb"/>
  <g clip-path="url(#c)">
    <rect width="64" height="64" fill="#f5f7fb"/>
    <rect y="8" width="64" height="6" fill="#ef4444"/>
    <rect y="20" width="64" height="6" fill="#ef4444"/>
    <rect y="32" width="64" height="6" fill="#ef4444"/>
    <rect y="44" width="64" height="6" fill="#ef4444"/>
    <rect y="56" width="64" height="6" fill="#ef4444"/>
    <rect width="30" height="30" fill="#1d4ed8"/>
    <text x="15" y="21" font-family="Arial, sans-serif" font-size="18" font-weight="900" fill="#f5f7fb" text-anchor="middle">W</text>
  </g>
  <circle cx="32" cy="32" r="30.5" fill="none" stroke="#1d4ed8" stroke-width="1.5"/>
</svg>`;
const SAMPLE_LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(SAMPLE_LOGO_SVG).toString("base64")}`;

// data/constitution.md is a separate plain file, not part of league-data.json
// (see README) — this sample content demonstrates the Markdown rendering
// (headers, bold, lists) so it can be visually checked without real content.
const SAMPLE_CONSTITUTION_MD = `PLACEHOLDER — this is sample content so you can see how the Constitution page
renders Markdown. Replace \`data/constitution.md\` with your real league's rules
once you have them.

# League Format

12 teams, head-to-head, **PPR scoring**. 13-week regular season followed by a
3-week playoff bracket among the top 6 finishers.

# Draft

Snake draft order is randomized each year. Draft date/time set by commissioner
vote.

# Scoring

Standard PPR — see the League Settings box above for the exact scoring/roster
rules currently on file (pulled automatically from Sleeper).

# Playoffs

- Top 6 teams make the playoffs.
- Seeds 1-2 get a first-round bye.
- Championship and 3rd place games are played in the final week.

# Payouts

TBD — replace with your league's actual payout structure.

# Penalties / Last Place

TBD — replace with your league's actual last-place punishment tradition.
`;

const SAMPLE_CONSTITUTION_UPDATES = {
  ruleChanges: [
    "PLACEHOLDER — sample rule change: Playoff field expands from 6 to 8 teams starting next season.",
  ],
  discussionItems: [
    "PLACEHOLDER — sample discussion item: Vote on switching from Half PPR to Full PPR scoring.",
  ],
};

const START_YEAR = 2012;
const END_YEAR = 2025;
const REGULAR_WEEKS = 13;
const PLAYOFF_WEEKS = 3;
const PLAYOFF_WEEK_START = REGULAR_WEEKS + 1;

// Seeded RNG (mulberry32) for reproducible sample data.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);

// Each manager gets a persistent "skill factor" so some are perennial
// contenders and others perennial cellar-dwellers — makes the all-time
// records/standings feel like a real league instead of pure noise.
const skillFactor = new Map(MANAGERS.map((m, i) => [m.ownerId, 0.85 + mulberry32(i + 1)() * 0.3]));

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function scoreFor(ownerId) {
  const base = 85 + rng() * 65; // 85-150
  const skewed = base * skillFactor.get(ownerId);
  return Number(skewed.toFixed(2));
}

function generateSeasonGames() {
  const games = [];
  const totalWeeks = REGULAR_WEEKS + PLAYOFF_WEEKS;
  for (let week = 1; week <= totalWeeks; week++) {
    const order = shuffled(MANAGERS.map((m) => m.ownerId));
    for (let i = 0; i < order.length; i += 2) {
      const aId = order[i];
      const bId = order[i + 1];
      const aTeam = MANAGERS.find((m) => m.ownerId === aId).teamName;
      const bTeam = MANAGERS.find((m) => m.ownerId === bId).teamName;
      games.push({
        week,
        isPlayoff: week >= PLAYOFF_WEEK_START,
        teamA: { ownerId: aId, teamName: aTeam, score: scoreFor(aId) },
        teamB: { ownerId: bId, teamName: bTeam, score: scoreFor(bId) },
      });
    }
  }
  return games;
}

function standingsFromGames(games) {
  const byOwner = new Map(
    MANAGERS.map((m) => [m.ownerId, { ownerId: m.ownerId, managerName: m.managerName, teamName: m.teamName, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }])
  );
  for (const g of games) {
    const a = byOwner.get(g.teamA.ownerId);
    const b = byOwner.get(g.teamB.ownerId);
    a.pointsFor += g.teamA.score;
    a.pointsAgainst += g.teamB.score;
    b.pointsFor += g.teamB.score;
    b.pointsAgainst += g.teamA.score;
    if (g.teamA.score > g.teamB.score) {
      a.wins++;
      b.losses++;
    } else if (g.teamB.score > g.teamA.score) {
      b.wins++;
      a.losses++;
    } else {
      a.ties++;
      b.ties++;
    }
  }
  return Array.from(byOwner.values())
    .map((r) => ({ ...r, pointsFor: Number(r.pointsFor.toFixed(2)), pointsAgainst: Number(r.pointsAgainst.toFixed(2)) }))
    .sort((x, y) => y.wins - x.wins || y.pointsFor - x.pointsFor)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

function generateSeason(year) {
  const games = generateSeasonGames();
  const standings = standingsFromGames(games);
  const champion = { ownerId: standings[0].ownerId, managerName: standings[0].managerName, teamName: standings[0].teamName };
  const runnerUp = { ownerId: standings[1].ownerId, managerName: standings[1].managerName, teamName: standings[1].teamName };

  return {
    year,
    leagueId: null,
    status: "complete",
    name: `WFFL ${year}`,
    source: "sample",
    standings,
    champion,
    runnerUp,
    games,
    settings: {
      numTeams: MANAGERS.length,
      playoffWeekStart: PLAYOFF_WEEK_START,
      playoffTeams: 6,
      rosterPositions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DEF", "K", "BN", "BN", "BN", "BN", "BN", "BN"],
      scoringSettings: { pass_td: 4, rec: 0.5, rush_td: 6, rec_td: 6 },
    },
    previousLeagueId: null,
  };
}

function generatePreDraftSeason(year) {
  const standings = MANAGERS.map((m, i) => ({
    ownerId: m.ownerId,
    managerName: m.managerName,
    teamName: m.teamName,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    rank: i + 1,
  }));
  return {
    year,
    leagueId: null,
    status: "pre_draft",
    name: `WFFL ${year}`,
    source: "sample",
    standings,
    champion: null,
    runnerUp: null,
    games: [],
    settings: {
      numTeams: MANAGERS.length,
      playoffWeekStart: PLAYOFF_WEEK_START,
      playoffTeams: 6,
      rosterPositions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DEF", "K", "BN", "BN", "BN", "BN", "BN", "BN"],
      scoringSettings: { pass_td: 4, rec: 0.5, rush_td: 6, rec_td: 6 },
    },
    previousLeagueId: null,
  };
}

// Fictional players (not real NFL players) for fabricating the "top
// individual performance" weekly award, since the sample generator doesn't
// simulate real player-level box scores.
const FAKE_PLAYERS = [
  { name: "Marcus Fielding", position: "RB", team: "KC" },
  { name: "Deion Marsh", position: "WR", team: "SF" },
  { name: "Trey Caldwell", position: "QB", team: "BUF" },
  { name: "Jaylen Cross", position: "WR", team: "MIA" },
  { name: "Antoine Ruiz", position: "RB", team: "DAL" },
];

async function main() {
  const existingRaw = await readFile(DATA_PATH, "utf-8").catch(() => null);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const seasons = [];
  for (let year = END_YEAR; year >= START_YEAR; year--) {
    seasons.push(generateSeason(year));
  }
  seasons.unshift(generatePreDraftSeason(2026));

  const allTime = computeAggregates(seasons);

  // Fabricate a "most recent week" awards section the same way the real
  // fetch script would compute it, using the latest complete season's games.
  const latestCompleteSeason = seasons.find((s) => s.year === END_YEAR);
  const latestWeek = REGULAR_WEEKS + PLAYOFF_WEEKS;
  const teamAwards = computeWeekAwards(latestCompleteSeason.games, latestWeek);
  const fakePlayer = FAKE_PLAYERS[Math.floor(rng() * FAKE_PLAYERS.length)];
  const fakeTeam = MANAGERS[Math.floor(rng() * MANAGERS.length)];
  const weeklyAwards = teamAwards
    ? {
        year: END_YEAR,
        ...teamAwards,
        topPlayer: {
          playerId: "sample",
          playerName: fakePlayer.name,
          position: fakePlayer.position,
          nflTeam: fakePlayer.team,
          points: Number((32 + rng() * 20).toFixed(2)),
          fantasyTeamName: fakeTeam.teamName,
          fantasyOwnerId: fakeTeam.ownerId,
        },
      }
    : null;

  // Fabricate a Draft Central section: a shuffled draft order, a countdown a
  // few weeks out, and a couple of sample trades/keepers.
  const draftOrder = shuffled(MANAGERS).map((m, i) => ({
    pick: i + 1,
    ownerId: m.ownerId,
    teamName: m.teamName,
    managerName: m.managerName,
  }));
  const draftStartTime = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  draftStartTime.setHours(19, 0, 0, 0);
  const draftCentral = {
    year: 2026,
    draftId: "sample",
    status: "pre_draft",
    startTime: draftStartTime.toISOString(),
    draftOrder,
    tradedPicks: [
      {
        round: 3,
        season: "2026",
        originalTeamName: MANAGERS[0].teamName,
        originalOwnerId: MANAGERS[0].ownerId,
        currentTeamName: MANAGERS[5].teamName,
        currentOwnerId: MANAGERS[5].ownerId,
        previousTeamName: MANAGERS[0].teamName,
        previousOwnerId: MANAGERS[0].ownerId,
      },
      {
        round: 7,
        season: "2026",
        originalTeamName: MANAGERS[2].teamName,
        originalOwnerId: MANAGERS[2].ownerId,
        currentTeamName: MANAGERS[9].teamName,
        currentOwnerId: MANAGERS[9].ownerId,
        previousTeamName: MANAGERS[2].teamName,
        previousOwnerId: MANAGERS[2].ownerId,
      },
    ],
    keepers: [
      { ownerId: MANAGERS[3].ownerId, teamName: MANAGERS[3].teamName, playerName: "Marcus Fielding", round: 4, notes: "" },
      { ownerId: MANAGERS[1].ownerId, teamName: MANAGERS[1].teamName, playerName: "Deion Marsh", round: 6, notes: "" },
      {
        ownerId: MANAGERS[7].ownerId,
        teamName: MANAGERS[7].teamName,
        playerName: "Trey Caldwell",
        round: 2,
        notes: "Cost increased due to breakout season",
      },
    ],
  };

  const output = {
    leagueName: existing.leagueName || "Whippany Fantasy Football League (WFFL)",
    platform: existing.platform || "sleeper",
    currentLeagueId: existing.currentLeagueId || null,
    isSampleData: true,
    lastUpdated: new Date().toISOString(),
    seasons,
    constitutionUpdates: existing.constitutionUpdates || SAMPLE_CONSTITUTION_UPDATES,
    logoPath: existing.logoPath && !existing.isSampleData ? existing.logoPath : SAMPLE_LOGO_DATA_URI,
    weeklyAwards,
    draftCentral,
    allTime,
    notes: [
      "This is fabricated SAMPLE data for previewing the site's design and features.",
      "It will be replaced once real Sleeper data and the 2012-2025 Excel import are in place.",
    ],
  };

  await writeFile(DATA_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${seasons.length} sample seasons to ${DATA_PATH}`);

  // Only drop the sample constitution.md if there isn't already a real one —
  // don't clobber real content with placeholder text on a re-run.
  const constitutionPath = path.join(__dirname, "..", "..", "data", "constitution.md");
  const alreadyHasReal = await readFile(constitutionPath, "utf-8")
    .then((text) => !text.includes("PLACEHOLDER"))
    .catch(() => false);
  if (!alreadyHasReal) {
    await writeFile(constitutionPath, SAMPLE_CONSTITUTION_MD, "utf-8");
    console.log(`Wrote sample constitution to ${constitutionPath}`);
  }
}

main();
