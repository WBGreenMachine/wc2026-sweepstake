const https = require("https");

const API_KEY      = process.env.API_FOOTBALL_KEY;
const DB_URL       = process.env.FIREBASE_DB_URL;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const WC_ID     = 1;
const WC_SEASON = 2026;

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "v3.football.api-sports.io",
      path, method: "GET",
      headers: { "x-apisports-key": API_KEY }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getAccessToken() {
  const { createSign } = require("crypto");
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  };
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const toSign  = `${header}.${payload}`;
  const sign    = createSign("RSA-SHA256");
  sign.update(toSign);
  const sig = sign.sign(PRIVATE_KEY, "base64url");
  const jwt = `${toSign}.${sig}`;

  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const options = {
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data).access_token); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function firebaseSet(path, value, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const url  = new URL(`${DB_URL}/${path}.json`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + `?access_token=${token}`,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

const NAME_MAP = {
  "Bosnia And Herzegovina": "Bosnia-Herzegovina",
  "Bosnia & Herzegovina":   "Bosnia-Herzegovina",
  "Bosnia and Herzegovina": "Bosnia-Herzegovina",
  "USA":                    "United States",
  "United States of America": "United States",
  "Cote d'Ivoire":          "Ivory Coast",
  "Congo DR":               "DR Congo",
  "Democratic Republic of Congo": "DR Congo",
  "Korea Republic":         "South Korea",
  "Türkiye":                "Turkey",
  "Curaçao":                "Curacao",
  "Cabo Verde":             "Cape Verde",
  "Czech Republic":         "Czechia",
  "IR Iran":                "Iran",
  "United Arab Emirates":   "UAE",
};
const norm = n => NAME_MAP[n] || n;

exports.handler = async function() {
  try {
    const token = await getAccessToken();

    // ── 1. FIXTURES (scores + goalscorers) ──────────────────
    const fixRes = await apiRequest(`/fixtures?league=${WC_ID}&season=${WC_SEASON}`);
    const fixtures = fixRes.response || [];
    console.log(`API returned ${fixtures.length} fixtures`);
    console.log(`API errors: ${JSON.stringify(fixRes.errors)}`);

    // Log first fixture to check data structure
    if(fixtures.length > 0) {
      const f0 = fixtures[0];
      console.log(`Sample fixture: ${f0.teams?.home?.name} vs ${f0.teams?.away?.name} - status: ${f0.fixture?.status?.short} - score: ${f0.goals?.home}-${f0.goals?.away}`);
    }

    const scores      = {};
    const goalscorers = {};

    for (const f of fixtures) {
      const status = f.fixture.status.short;
      const isDone = ["FT","AET","PEN"].includes(status);
      const isLive = ["1H","HT","2H","ET","P"].includes(status);
      if (!isDone && !isLive) continue;

      const home = norm(f.teams.home.name);
      const away = norm(f.teams.away.name);
      const hs   = f.goals.home ?? 0;
      const away_score = f.goals.away ?? 0;
      if (f.goals.home === null || f.goals.away === null) continue;

      const round = f.league.round || "";
      if (round.toLowerCase().includes("group")) {
        scores[`${home}_${away}`] = { hs: hs, as: away_score, live: isLive };
      }

      if (isDone || isLive) {
        const evRes = await apiRequest(`/fixtures/events?fixture=${f.fixture.id}&type=Goal`);
        const homeGoals = [], awayGoals = [];
        for (const ev of (evRes.response || [])) {
          if (ev.type !== "Goal") continue;
          const entry = `${ev.player.name} ${ev.time.elapsed}'`;
          const isHome = norm(ev.team.name) === home;
          if (isHome) homeGoals.push(entry); else awayGoals.push(entry);
        }
        const matchKey = round.toLowerCase().includes("group") ? `${home}_${away}` : `ko_fixture_${f.fixture.id}`;
        goalscorers[matchKey] = { home: homeGoals, away: awayGoals };
      }
    }

    await firebaseSet("scores",      scores,      token);
    await firebaseSet("goalscorers", goalscorers, token);

    // ── 2. TOP SCORERS ──────────────────────────────────────
    const scorersRes = await apiRequest(`/players/topscorers?league=${WC_ID}&season=${WC_SEASON}`);
    const topScorers = (scorersRes.response || []).slice(0, 20).map(p => ({
      name:     p.player.name,
      photo:    p.player.photo,
      team:     norm(p.statistics[0]?.team?.name || ""),
      goals:    p.statistics[0]?.goals?.total || 0,
      assists:  p.statistics[0]?.goals?.assists || 0,
      games:    p.statistics[0]?.games?.appearences || 0,
      shots:    p.statistics[0]?.shots?.total || 0,
      yellows:  p.statistics[0]?.cards?.yellow || 0,
      reds:     p.statistics[0]?.cards?.red || 0,
      dribbles: p.statistics[0]?.dribbles?.success || 0,
    }));
    await firebaseSet("topScorers", topScorers, token);

    // ── 3. PLAYER STATS (top assists, shots, dribbles, cards) 
    const assistsRes  = await apiRequest(`/players/topassists?league=${WC_ID}&season=${WC_SEASON}`);
    const topAssists = (assistsRes.response || []).slice(0, 10).map(p => ({
      name:    p.player.name,
      team:    norm(p.statistics[0]?.team?.name || ""),
      assists: p.statistics[0]?.goals?.assists || 0,
      games:   p.statistics[0]?.games?.appearences || 0,
    }));
    await firebaseSet("topAssists", topAssists, token);

    const yellowsRes = await apiRequest(`/players/topyellowcards?league=${WC_ID}&season=${WC_SEASON}`);
    const topYellows = (yellowsRes.response || []).slice(0, 10).map(p => ({
      name:    p.player.name,
      team:    norm(p.statistics[0]?.team?.name || ""),
      yellows: p.statistics[0]?.cards?.yellow || 0,
      reds:    p.statistics[0]?.cards?.red || 0,
      games:   p.statistics[0]?.games?.appearences || 0,
    }));
    await firebaseSet("topYellows", topYellows, token);

    const redsRes = await apiRequest(`/players/topredcards?league=${WC_ID}&season=${WC_SEASON}`);
    const topReds = (redsRes.response || []).slice(0, 10).map(p => ({
      name:    p.player.name,
      team:    norm(p.statistics[0]?.team?.name || ""),
      yellows: p.statistics[0]?.cards?.yellow || 0,
      reds:    p.statistics[0]?.cards?.red || 0,
      games:   p.statistics[0]?.games?.appearences || 0,
    }));
    await firebaseSet("topReds", topReds, token);

    // ── 4. TEAM STATS ────────────────────────────────────────
    const teamsRes = await apiRequest(`/teams/statistics?league=${WC_ID}&season=${WC_SEASON}`);
    // standings gives us goals for/against per team
    const standingsRes = await apiRequest(`/standings?league=${WC_ID}&season=${WC_SEASON}`);
    const standings = standingsRes.response?.[0]?.league?.standings?.flat() || [];

    const teamStats = standings.map(t => ({
      name:      norm(t.team.name),
      played:    t.all.played,
      goalsFor:  t.all.goals.for,
      goalsAgainst: t.all.goals.against,
      wins:      t.all.win,
      draws:     t.all.draw,
      losses:    t.all.lose,
      pts:       t.points,
    }));
    await firebaseSet("teamStats", teamStats, token);

    // Team cards — from fixtures events
    const teamCards = {};
    for (const f of fixtures) {
      const status = f.fixture.status.short;
      if (!["FT","AET","PEN","1H","HT","2H","ET","P"].includes(status)) continue;
      const evRes = await apiRequest(`/fixtures/events?fixture=${f.fixture.id}&type=Card`);
      for (const ev of (evRes.response || [])) {
        const team = norm(ev.team.name);
        if (!teamCards[team]) teamCards[team] = { yellows: 0, reds: 0 };
        if (ev.detail === "Yellow Card") teamCards[team].yellows++;
        if (ev.detail === "Red Card" || ev.detail === "Second Yellow card") teamCards[team].reds++;
      }
    }
    await firebaseSet("teamCards", teamCards, token);

    console.log("Sync complete");
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch(err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
