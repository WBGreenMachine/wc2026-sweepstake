const https = require("https");

// --- Config -----------------------------------------------------------------
// DB_URL stays as its own env var (it's a plain URL, never a problem).
const DB_URL = process.env.FIREBASE_DB_URL;

// Everything else comes from ONE base64-encoded service-account JSON.
// This avoids all newline/escaping problems with the private key.
let CLIENT_EMAIL = "";
let PRIVATE_KEY  = "";
try {
  const raw = Buffer.from(process.env.FIREBASE_SA_B64 || "", "base64").toString("utf8");
  const sa  = JSON.parse(raw);
  CLIENT_EMAIL = sa.client_email;
  PRIVATE_KEY  = sa.private_key; // JSON.parse restores real newlines automatically
} catch (e) {
  console.error("Could not decode FIREBASE_SA_B64: " + e.message);
}

const WC_JSON_URL = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

// --- Helpers ----------------------------------------------------------------
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse failed: " + e.message)); }
      });
    }).on("error", e => reject(new Error("HTTP error: " + e.message)));
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
        "Content-Length": Buffer.byteLength(body)
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
        } catch (e) { reject(new Error("Token parse failed: " + e.message)); }
      });
    });
    req.on("error", e => reject(new Error("Token request error: " + e.message)));
    req.write(body);
    req.end();
  });
}

function firebaseSet(path, value, token) {
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

// --- Handler ----------------------------------------------------------------
exports.handler = async function () {
  console.log("=== VERSION: SA_B64-diagnostic-1 ===");
  console.log("SA_B64 present: " + !!process.env.FIREBASE_SA_B64 + " | length: " + (process.env.FIREBASE_SA_B64 || "").length);
  console.log("Old FIREBASE_PRIVATE_KEY still present: " + !!process.env.FIREBASE_PRIVATE_KEY);
  console.log("Email being used: " + CLIENT_EMAIL);
  console.log("Key first line: " + (PRIVATE_KEY ? PRIVATE_KEY.split("\n")[0] : "(none)"));
  console.log("Key line count: " + (PRIVATE_KEY ? PRIVATE_KEY.split("\n").length : 0));
  console.log("Function started");
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.error("Missing service account. Is FIREBASE_SA_B64 set correctly?");
    return { statusCode: 500, body: "Missing service account" };
  }
  try {
    console.log("Fetching WC JSON...");
    const data = await fetchUrl(WC_JSON_URL);
    const matches = data.matches || [];
    console.log("Fetched " + matches.length + " matches");

    console.log("Getting Firebase token...");
    const token = await getAccessToken();
    console.log("Got token OK");

    const scores = {};
    const goalscorers = {};
    let scored = 0;

    for (const m of matches) {
      if (!m.score || !m.score.ft) continue;  // skip unplayed
      const home = norm(m.team1);
      const away = norm(m.team2);
      scores[`${home}_${away}`] = { hs: m.score.ft[0], as: m.score.ft[1], live: false };
      scored++;

      const homeGoals = (m.goals1 || []).map(g => `${g.name} ${g.minute}'`);
      const awayGoals = (m.goals2 || []).map(g => `${g.name} ${g.minute}'`);
      if (homeGoals.length || awayGoals.length) {
        goalscorers[`${home}_${away}`] = { home: homeGoals, away: awayGoals };
      }
    }

    console.log("Scored matches found: " + scored);
    await firebaseSet("scores", scores, token);
    await firebaseSet("goalscorers", goalscorers, token);
    console.log("Sync complete - wrote " + scored + " scores");

    return { statusCode: 200, body: JSON.stringify({ ok: true, scored }) };
  } catch (err) {
    console.error("ERROR: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
