// Shared data loading + small helpers used by every page.

async function loadLeagueData() {
  const res = await fetch("data/league-data.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load league data (${res.status})`);
  return res.json();
}

function formatDate(iso) {
  if (!iso) return "never (not yet fetched)";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function winPct(wins, losses, ties) {
  const games = wins + losses + ties;
  if (games === 0) return "0.000";
  return ((wins + ties * 0.5) / games).toFixed(3).replace(/^0/, "0");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function emptyState(message) {
  return el("div", { class: "empty-state" }, [
    el("p", {}, message),
  ]);
}

function setActiveNav() {
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("nav.site-nav a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href === path) a.classList.add("active");
  });
}

function setLastUpdated(data) {
  const target = document.getElementById("last-updated");
  if (target) target.textContent = `Data last updated: ${formatDate(data.lastUpdated)}`;
}

document.addEventListener("DOMContentLoaded", setActiveNav);

function applyLogo(data) {
  if (!data.logoPath) return;
  const ball = document.querySelector(".site-title .ball");
  if (!ball) return;
  const img = document.createElement("img");
  img.alt = "League logo";
  img.className = "league-logo";
  img.onerror = () => img.remove(); // fall back to the emoji if the file's missing/broken
  img.onload = () => (ball.style.display = "none");
  ball.insertAdjacentElement("afterend", img);
  img.src = data.logoPath; // set src last so onload/onerror are already wired up
}

function sampleBanner(data) {
  if (!data.isSampleData) return null;
  return el("div", { class: "sample-banner" }, [
    "⚠️ This site is currently showing ",
    el("strong", {}, "sample placeholder data"),
    " while real league history is being imported — nothing here reflects your actual league yet.",
  ]);
}

function managerLink(ownerId, label) {
  if (!ownerId) return document.createTextNode(label);
  return el("a", { href: `manager.html?id=${encodeURIComponent(ownerId)}` }, label);
}

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function careerStanding(data, ownerId) {
  return (data.allTime?.standings || []).find((s) => s.ownerId === ownerId) || null;
}

// All seasons a given ownerId appears in, oldest first, with that owner's row attached.
function seasonRowsFor(data, ownerId) {
  return (data.seasons || [])
    .filter((s) => s.status !== "pre_draft")
    .slice()
    .sort((a, b) => a.year - b.year)
    .map((season) => {
      const row = (season.standings || []).find((r) => r.ownerId === ownerId);
      if (!row) return null;
      return {
        year: season.year,
        row,
        isChampion: season.champion?.ownerId === ownerId,
        isRunnerUp: season.runnerUp?.ownerId === ownerId,
      };
    })
    .filter(Boolean);
}

// Head-to-head entries involving ownerId, each annotated with the opponent's id.
function headToHeadFor(data, ownerId) {
  return (data.allTime?.headToHead || [])
    .filter((h) => h.ownerIds.includes(ownerId))
    .map((h) => {
      const opponentId = h.ownerIds.find((id) => id !== ownerId);
      return {
        opponentId,
        wins: h.wins[ownerId] || 0,
        losses: h.wins[opponentId] || 0,
        ties: h.ties,
        meetings: h.meetings,
        pointsFor: h.pointsBy[ownerId] || 0,
        pointsAgainst: h.pointsBy[opponentId] || 0,
      };
    });
}
