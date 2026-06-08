const https = require("https");

// ── CONFIG ────────────────────────────────────────────────
const API_KEY      = process.env.API_FOOTBALL_KEY;
const DB_URL       = process.env.FIREBASE_DB_URL;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const WC_2026_ID   = 1; // API-Football competition ID for FIFA World Cup 2026
const WC_2026_SEASON = 2026;

// ── HELPERS ───────────────────────────────────────────────
function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "v3.football.api-sports.io",
      path,
      method:  "GET",
      headers: { "x-apisports-key": API_KEY }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Generate a Google OAuth2 access token from service account credentials
async function getAccessToken() {
  const { createSign } = require("crypto");
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now
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
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).access_token); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Write to Firebase REST API
async function firebaseSet(path, value, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const url  = new URL(`${DB_URL}/${path}.json`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + `?access_token=${token}`,
      method:   "PUT",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Team name normalisation — API names → our app names
const NAME_MAP = {
  "Bosnia And Herzegovina": "Bosnia-Herzegovina",
  "Bosnia & Herzegovina":   "Bosnia-Herzegovina",
  "USA":                    "United States",
  "United States of America": "United States",
  "Ivory Coast":            "Ivory Coast",
  "Cote d'Ivoire":          "Ivory Coast",
  "DR Congo":               "DR Congo",
  "Congo DR":               "DR Congo",
  "Democratic Republic of Congo": "DR Congo",
  "Korea Republic":         "South Korea",
  "South Korea":            "South Korea",
  "Türkiye":                "Turkey",
  "Turkey":                 "Turkey",
  "Curacao":                "Curacao",
  "Curaçao":                "Curacao",
  "Cape Verde":             "Cape Verde",
  "Cabo Verde":             "Cape Verde",
};
function normName(n) { return NAME_MAP[n] || n; }

// ── MAIN HANDLER ─────────────────────────────────────────
exports.handler = async function(event, context) {
  try {
    console.log("Starting sync...");

    // 1. Get all WC 2026 fixtures
    const fixturesRes = await apiRequest(
      `/fixtures?league=${WC_2026_ID}&season=${WC_2026_SEASON}`
    );
    const fixtures = fixturesRes.response || [];
    console.log(`Got ${fixtures.length} fixtures`);

    // 2. Get Firebase access token
    const token = await getAccessToken();

    // 3. Process group stage scores
    const scores     = {};
    const goalscorers = {};

    for (const f of fixtures) {
      const status = f.fixture.status.short;
      const isDone = ["FT","AET","PEN"].includes(status);
      const isLive = ["1H","HT","2H","ET","P"].includes(status);

      if (!isDone && !isLive) continue;

      const home = normName(f.teams.home.name);
      const away = normName(f.teams.away.name);
      const hs   = f.goals.home;
      const as_  = f.goals.away;

      if (hs === null || as_ === null) continue;

      // Group stage matches (round contains "Group")
      const round = f.league.round || "";
      if (round.toLowerCase().includes("group")) {
        const key = `${home}_${away}`;
        scores[key] = { hs, as: as_ };
      }

      // Knockout matches — we store by fixture ID so admin can map them
      if (["Round of 32","Round of 16","Quarter-finals","Semi-finals","Final","3rd Place Final"].some(r => round.includes(r))) {
        const fid = String(f.fixture.id);
        const winner = isDone
          ? (hs > as_ ? home : as_ > hs ? away : f.teams.home.winner ? home : f.teams.away.winner ? away : null)
          : null;
        scores[`ko_fixture_${fid}`] = { home, away, hs, as: as_, round, winner, status };
      }

      // Get goal scorers for this fixture
      if (isDone || isLive) {
        const eventsRes = await apiRequest(`/fixtures/events?fixture=${f.fixture.id}&type=Goal`);
        const events    = eventsRes.response || [];
        const homeGoals = [];
        const awayGoals = [];
        for (const ev of events) {
          if (ev.type !== "Goal") continue;
          const scorer = ev.player.name;
          const minute = ev.time.elapsed;
          const isHome = ev.team.name === f.teams.home.name || normName(ev.team.name) === home;
          const entry  = `${scorer} ${minute}'`;
          if (isHome) homeGoals.push(entry);
          else awayGoals.push(entry);
        }
        const matchKey = round.toLowerCase().includes("group")
          ? `${home}_${away}`
          : `ko_fixture_${f.fixture.id}`;
        goalscorers[matchKey] = { home: homeGoals, away: awayGoals };
      }
    }

    // 4. Write to Firebase
    await firebaseSet("scores",      scores,      token);
    await firebaseSet("goalscorers", goalscorers, token);

    console.log(`Synced ${Object.keys(scores).length} matches, ${Object.keys(goalscorers).length} with goalscorers`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, matches: Object.keys(scores).length })
    };

  } catch (err) {
    console.error("Sync error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
