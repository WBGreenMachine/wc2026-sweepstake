const https = require("https");

const DB_URL       = process.env.FIREBASE_DB_URL;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const WC_JSON_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error("JSON parse failed: " + e.message + " | raw: " + data.slice(0, 200)));
        }
      });
    }).on("error", (e) => reject(new Error("HTTP error: " + e.message)));
  });
}

async function getAccessToken() {
  const { createSign } = require("crypto");
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
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
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": body.length
      }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) reject(new Error("No access token: " + data));
          else resolve(parsed.access_token);
        } catch(e) {
          reject(new Error("Token parse failed: " + e.message));
        }
      });
    });
    req.on("error", e => reject(new Error("Token request error: " + e.message)));
    req.write(body);
    req.end();
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
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", e => reject(new Error("Firebase error: " + e.message)));
    req.write(body);
    req.end();
  });
}

const NAME_MAP = {
  "Czech Republic":         "Czechia",
  "Bosnia & Herzegovina":   "Bosnia-Herzegovina",
  "Bosnia and Herzegovina": "Bosnia-Herzegovina",
  "Côte d'Ivoire":          "Ivory Coast",
  "Cote d'Ivoire":          "Ivory Coast",
  "Congo DR":               "DR Congo",
  "Korea Republic":         "South Korea",
  "IR Iran":                "Iran",
  "Curaçao":                "Curacao",
  "Cabo Verde":             "Cape Verde",
  "USA":                    "United States",
};
const norm = n => NAME_MAP[n] || n;

exports.handler = async function() {
  console.log("Function started");
  try {
    console.log("Fetching WC JSON...");
    const data = await fetchUrl(WC_JSON_URL);
    const matches = data.matches || [];
    console.log("Fetched " + matches.length + " matches");

    console.log("Getting Firebase token...");
    const token = await getAccessToken();
    console.log("Got token");

    const scores = {};
    const goalscorers = {};
    let scored = 0;

    for (const m of matches) {
      if (!m.group) continue; // skip knockout rounds
      const home = norm(m.team1);
      const away = norm(m.team2);
      if (!m.score || !m.score.ft) continue;

      const hs  = m.score.ft[0];
      const as_ = m.score.ft[1];
      scores[`${home}_${away}`] = { hs, as: as_, live: false };
      scored++;

      const homeGoals = (m.goals1 || []).map(g => `${g.name} ${g.minute}'`);
      const awayGoals = (m.goals2 || []).map(g => `${g.name} ${g.minute}'`);
      if (homeGoals.length || awayGoals.length) {
        goalscorers[`${home}_${away}`] = { home: homeGoals, away: awayGoals };
      }
    }

    console.log("Scored matches found: " + scored);
    console.log("Writing scores to Firebase...");
    await firebaseSet("scores", scores, token);
    console.log("Writing goalscorers to Firebase...");
    await firebaseSet("goalscorers", goalscorers, token);
    console.log("Sync complete - wrote " + scored + " scores");

    return { statusCode: 200, body: JSON.stringify({ ok: true, scored }) };

  } catch(err) {
    console.error("ERROR: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
