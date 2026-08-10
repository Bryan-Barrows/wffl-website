// Shared aggregation logic: turns a `seasons` array (the same shape used by
// both the Sleeper fetch script and the future Excel importer) into the
// derived all-time data the site renders: career standings, championships,
// records, and head-to-head.
//
// Season shape expected:
// {
//   year, leagueId, status, name, source,
//   standings: [{ ownerId, managerName, teamName, wins, losses, ties, pointsFor, pointsAgainst, rank }],
//   champion: { ownerId, managerName, teamName } | null,
//   runnerUp: { ownerId, managerName, teamName } | null,
//   games: [{ week, isPlayoff, teamA: { ownerId, teamName, score }, teamB: { ownerId, teamName, score } }]
// }

export function computeAggregates(seasons) {
  const careerByOwner = computeCareerStandings(seasons);
  const championships = computeChampionships(careerByOwner);
  const records = computeRecords(seasons, careerByOwner);
  const headToHead = computeHeadToHead(seasons);

  return {
    standings: Array.from(careerByOwner.values()).sort(
      (a, b) => b.wins - a.wins || b.championships - a.championships
    ),
    championships,
    records,
    headToHead,
  };
}

// Team-level awards (most/fewest points, biggest margin) for a single week
// of a single season's games. Doesn't know about individual NFL players —
// that's Sleeper-specific and layered on separately by the fetch script.
export function computeWeekAwards(games, week) {
  const weekGames = (games || []).filter((g) => g.week === week && g.teamA && g.teamB);
  if (weekGames.length === 0) return null;

  const performances = [];
  for (const g of weekGames) {
    performances.push({ ownerId: g.teamA.ownerId, teamName: g.teamA.teamName, points: g.teamA.score, opponentTeamName: g.teamB.teamName });
    performances.push({ ownerId: g.teamB.ownerId, teamName: g.teamB.teamName, points: g.teamB.score, opponentTeamName: g.teamA.teamName });
  }

  const mostPoints = performances.reduce((best, p) => (!best || p.points > best.points ? p : best), null);
  const fewestPoints = performances.reduce((worst, p) => (!worst || p.points < worst.points ? p : worst), null);

  let biggestMargin = null;
  for (const g of weekGames) {
    if (g.teamA.score === g.teamB.score) continue;
    const margin = Number(Math.abs(g.teamA.score - g.teamB.score).toFixed(2));
    if (!biggestMargin || margin > biggestMargin.margin) {
      const winner = g.teamA.score > g.teamB.score ? g.teamA : g.teamB;
      const loser = g.teamA.score > g.teamB.score ? g.teamB : g.teamA;
      biggestMargin = { margin, winner, loser };
    }
  }

  return { week, mostPoints, fewestPoints, biggestMargin };
}

function computeCareerStandings(seasons) {
  const byOwner = new Map();

  for (const season of seasons) {
    if (season.status === "pre_draft") continue; // nothing played yet; don't count toward career stats
    for (const row of season.standings || []) {
      if (!row.ownerId) continue;
      const agg =
        byOwner.get(row.ownerId) ||
        {
          ownerId: row.ownerId,
          managerName: row.managerName,
          teamName: row.teamName,
          seasonsPlayed: 0,
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          championships: 0,
          championshipYears: [],
          years: [],
        };
      agg.seasonsPlayed += 1;
      agg.wins += row.wins;
      agg.losses += row.losses;
      agg.ties += row.ties;
      agg.pointsFor += row.pointsFor;
      agg.pointsAgainst += row.pointsAgainst;
      agg.teamName = row.teamName; // most recent team name wins
      agg.managerName = row.managerName;
      agg.years.push(season.year);
      byOwner.set(row.ownerId, agg);
    }
    if (season.champion?.ownerId) {
      const agg = byOwner.get(season.champion.ownerId);
      if (agg) {
        agg.championships += 1;
        agg.championshipYears.push(season.year);
      }
    }
  }

  for (const agg of byOwner.values()) {
    agg.pointsFor = Number(agg.pointsFor.toFixed(2));
    agg.pointsAgainst = Number(agg.pointsAgainst.toFixed(2));
    agg.years.sort((a, b) => a - b);
    agg.championshipYears.sort((a, b) => a - b);
  }

  return byOwner;
}

function computeChampionships(careerByOwner) {
  return Array.from(careerByOwner.values())
    .filter((a) => a.championships > 0)
    .map((a) => ({
      ownerId: a.ownerId,
      managerName: a.managerName,
      teamName: a.teamName,
      count: a.championships,
      years: a.championshipYears,
    }))
    .sort((a, b) => b.count - a.count);
}

function flattenGames(seasons) {
  const games = [];
  for (const season of seasons) {
    for (const g of season.games || []) {
      if (!g.teamA || !g.teamB) continue; // skip byes / incomplete pairs
      games.push({ year: season.year, ...g });
    }
  }
  return games;
}

function computeRecords(seasons, careerByOwner) {
  const games = flattenGames(seasons);
  const nameFor = (ownerId) => {
    const c = careerByOwner.get(ownerId);
    return c ? { managerName: c.managerName, teamName: c.teamName } : { managerName: "Unknown", teamName: "Unknown" };
  };

  // Every individual scoring performance (one per team per game).
  const performances = [];
  for (const g of games) {
    performances.push({ year: g.year, week: g.week, ownerId: g.teamA.ownerId, teamName: g.teamA.teamName, points: g.teamA.score, opponentTeamName: g.teamB.teamName });
    performances.push({ year: g.year, week: g.week, ownerId: g.teamB.ownerId, teamName: g.teamB.teamName, points: g.teamB.score, opponentTeamName: g.teamA.teamName });
  }

  const mostPointsGame = performances.reduce((best, p) => (!best || p.points > best.points ? p : best), null);
  const fewestPointsGame = performances.reduce((worst, p) => (!worst || p.points < worst.points ? p : worst), null);

  const decidedGames = games.filter((g) => g.teamA.score !== g.teamB.score);

  let biggestBlowout = null;
  let closestGame = null;
  for (const g of decidedGames) {
    const margin = Number(Math.abs(g.teamA.score - g.teamB.score).toFixed(2));
    const winner = g.teamA.score > g.teamB.score ? g.teamA : g.teamB;
    const loser = g.teamA.score > g.teamB.score ? g.teamB : g.teamA;
    if (!biggestBlowout || margin > biggestBlowout.margin) {
      biggestBlowout = { year: g.year, week: g.week, margin, winner, loser };
    }
    if (!closestGame || margin < closestGame.margin) {
      closestGame = { year: g.year, week: g.week, margin, teamA: g.teamA, teamB: g.teamB };
    }
  }

  let mostPointsSeason = null;
  let fewestPointsSeason = null;
  for (const season of seasons) {
    if (season.status === "pre_draft") continue; // nothing played yet
    for (const row of season.standings || []) {
      const entry = { year: season.year, ownerId: row.ownerId, teamName: row.teamName, managerName: row.managerName, points: row.pointsFor };
      if (!mostPointsSeason || row.pointsFor > mostPointsSeason.points) mostPointsSeason = entry;
      if (!fewestPointsSeason || row.pointsFor < fewestPointsSeason.points) fewestPointsSeason = entry;
    }
  }

  // Longest win streak, across seasons, per manager (chronological by year/week).
  const perfByOwner = new Map();
  for (const g of games) {
    pushPerf(perfByOwner, g.teamA.ownerId, g.year, g.week, g.teamA.score > g.teamB.score);
    pushPerf(perfByOwner, g.teamB.ownerId, g.year, g.week, g.teamB.score > g.teamA.score);
  }

  let longestWinStreak = null;
  for (const [ownerId, perfs] of perfByOwner) {
    perfs.sort((a, b) => a.year - b.year || a.week - b.week);
    let streak = 0;
    let streakStart = null;
    let prev = null;
    for (const p of perfs) {
      if (p.win) {
        if (streak === 0) streakStart = p;
        streak++;
      } else {
        if (streak > (longestWinStreak?.length || 0)) {
          longestWinStreak = { ownerId, length: streak, start: streakStart, end: prev };
        }
        streak = 0;
      }
      prev = p;
    }
    if (streak > (longestWinStreak?.length || 0)) {
      longestWinStreak = { ownerId, length: streak, start: streakStart, end: prev };
    }
  }
  if (longestWinStreak) {
    Object.assign(longestWinStreak, nameFor(longestWinStreak.ownerId));
  }

  return {
    mostPointsGame,
    fewestPointsGame,
    mostPointsSeason,
    fewestPointsSeason,
    biggestBlowout,
    closestGame,
    longestWinStreak,
  };
}

function pushPerf(map, ownerId, year, week, win) {
  if (!ownerId) return;
  if (!map.has(ownerId)) map.set(ownerId, []);
  map.get(ownerId).push({ year, week, win });
}

function computeHeadToHead(seasons) {
  const games = flattenGames(seasons);
  const key = (a, b) => [a, b].sort().join("|");
  const map = new Map();

  for (const g of games) {
    const a = g.teamA;
    const b = g.teamB;
    if (!a.ownerId || !b.ownerId || a.ownerId === b.ownerId) continue;
    const k = key(a.ownerId, b.ownerId);
    const entry =
      map.get(k) ||
      {
        ownerIds: [a.ownerId, b.ownerId].sort(),
        wins: {}, // ownerId -> win count
        ties: 0,
        meetings: 0,
        pointsBy: {}, // ownerId -> total points scored in these meetings
      };
    entry.meetings += 1;
    entry.wins[a.ownerId] = entry.wins[a.ownerId] || 0;
    entry.wins[b.ownerId] = entry.wins[b.ownerId] || 0;
    entry.pointsBy[a.ownerId] = (entry.pointsBy[a.ownerId] || 0) + a.score;
    entry.pointsBy[b.ownerId] = (entry.pointsBy[b.ownerId] || 0) + b.score;
    if (a.score > b.score) entry.wins[a.ownerId] += 1;
    else if (b.score > a.score) entry.wins[b.ownerId] += 1;
    else entry.ties += 1;
    map.set(k, entry);
  }

  return Array.from(map.values());
}
