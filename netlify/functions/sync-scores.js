const https = require("https");

const DB_URL       = process.env.FIREBASE_DB_URL;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const WC_JSON_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
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

// Normalise team names to match our app
const NAME_MAP = {
  "Czech Republic":         "Czechia",
  "Bosnia & Herzegovina":   "Bosnia-Herzegovina",
  "Bosnia and Herzegovina": "Bosnia-Herzegovina",
  "Côte d'Ivoire":          "Ivory Coast",
  "Cote d'Ivoire":          "Ivory Coast",
  "DR Congo":               "DR Congo",
  "Congo DR":               "DR Congo",
  "Korea Republic":         "South Korea",
  "IR Iran":                "Iran",
  "Curaçao":                "Curacao",
  "Cabo Verde":             "Cape Verde",
  "USA":                    "United States",
};
const norm = n => NAME_MAP[n] || n;

exports.handler = async function() {
  try {
    const token = await getAccessToken();

    // Fetch free WC 2026 JSON from openfootball
    const data = await fetchUrl(WC_JSON_URL);
    const matches = data.matches || [];
    console.log(`Fetched ${matches.length} matches from openfootball`);

    const scores = {};
    const goalscorers = {};

    for (const m of matches) {
      const home = norm(m.team1);
      const away = norm(m.team2);
      const score = m.score;

      // Only group stage
      if (!m.group) continue;

      if (score && score.ft && score.ft.length === 2) {
        const hs = score.ft[0];
        const as_ = score.ft[1];
        scores[`${home}_${away}`] = { hs, as: as_, live: false };

        // Goalscorers
        const homeGoals = (m.goals1 || []).map(g => `${g.name} ${g.minute}'`);
        const awayGoals = (m.goals2 || []).map(g => `${g.name} ${g.minute}'`);
        if (homeGoals.length || awayGoals.length) {
          goalscorers[`${home}_${away}`] = { home: homeGoals, away: awayGoals };
        }
      }
    }

    console.log(`Writing ${Object.keys(scores).length} scores to Firebase`);
    await firebaseSet("scores", scores, token);
    await firebaseSet("goalscorers", goalscorers, token);

    console.log("Sync complete");
    return { statusCode: 200, body: JSON.stringify({ ok: true, matches: Object.keys(scores).length }) };

  } catch(err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
