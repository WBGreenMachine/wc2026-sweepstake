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

async function firebaseSet(path, value, token) {
  return firebaseWrite(path, value, token, "PUT");
}
async function firebasePatch(path, value, token) {
  return firebaseWrite(path, value, token, "PATCH");
}
async function firebaseWrite(path, value, token, method) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const url  = new URL(`${DB_URL}/${path}.json`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + `?access_token=${token}`,
      method: method,
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

    // Match number → bracket slot key (must match index.html's KO_NUM_TO_KEY)
    const KO_NUM_TO_KEY = {
      74:'r32_0',77:'r32_1',73:'r32_2',75:'r32_3',83:'r32_4',84:'r32_5',
      81:'r32_6',82:'r32_7',76:'r32_8',78:'r32_9',79:'r32_10',80:'r32_11',
      86:'r32_12',88:'r32_13',85:'r32_14',87:'r32_15',
      89:'r16_0',90:'r16_1',93:'r16_2',94:'r16_3',
      91:'r16_4',92:'r16_5',95:'r16_6',96:'r16_7',
      97:'qf_0',98:'qf_1',99:'qf_2',100:'qf_3',
      101:'sf_0',102:'sf_1',103:'third_0',104:'final_0'
    };
    // All known team names for checking if a name is real vs a code
    const KNOWN_TEAMS = new Set(Object.keys(NAME_MAP).map(norm).concat([
      "Mexico","South Africa","South Korea","Czechia","Canada","Bosnia-Herzegovina",
      "Qatar","Switzerland","Brazil","Morocco","Haiti","Scotland","United States",
      "Paraguay","Australia","Turkey","Germany","Curacao","Ivory Coast","Ecuador",
      "Netherlands","Japan","Sweden","Tunisia","Belgium","Egypt","Iran","New Zealand",
      "Spain","Cape Verde","Saudi Arabia","Uruguay","France","Senegal","Iraq","Norway",
      "Argentina","Algeria","Austria","Jordan","Portugal","DR Congo","Uzbekistan",
      "Colombia","England","Croatia","Ghana","Panama"
    ]));

    const ko = {};  // KO entries to PATCH into Firebase

    for (const m of matches) {
      if (!m.score || !m.score.ft) continue;  // skip unplayed
      const home = norm(m.team1);
      const away = norm(m.team2);
      const hs = m.score.ft[0];
      const as_ = m.score.ft[1];

      scores[`${home}_${away}`] = { hs, as: as_, live: false };
      scored++;

      const homeGoals = (m.goals1 || []).map(g => `${g.name} ${g.minute}'`);
      const awayGoals = (m.goals2 || []).map(g => `${g.name} ${g.minute}'`);
      if (homeGoals.length || awayGoals.length) {
        goalscorers[`${home}_${away}`] = { home: homeGoals, away: awayGoals };
      }

      // Write KO matches to the ko node (only if both teams are real, not position codes)
      // Only write entries where we can determine a winner — preserves admin-set penalty winners
      if (m.num && KO_NUM_TO_KEY[m.num] && KNOWN_TEAMS.has(home) && KNOWN_TEAMS.has(away)) {
        const slotKey = KO_NUM_TO_KEY[m.num];
        const entry = { home, away, hs, as: as_ };
        let hasWinner = false;

        if ((m.score.p && m.score.p.length === 2) || (m.score.pen && m.score.pen.length === 2)) {
          const pen = m.score.p || m.score.pen;
          entry.penHome = pen[0];
          entry.penAway = pen[1];
          entry.winner = pen[0] > pen[1] ? home : away;
          hasWinner = true;
        } else if (m.score.et && m.score.et.length === 2) {
          entry.etHome = m.score.et[0];
          entry.etAway = m.score.et[1];
          entry.hs = m.score.et[0];
          entry.as = m.score.et[1];
          if (m.score.et[0] !== m.score.et[1]) {
            entry.winner = m.score.et[0] > m.score.et[1] ? home : away;
            hasWinner = true;
          }
        } else if (hs > as_) {
          entry.winner = home;
          hasWinner = true;
        } else if (as_ > hs) {
          entry.winner = away;
          hasWinner = true;
        }

        // Only write to ko when we have a definitive winner
        // Draws (pending penalty data) are left for admin to resolve
        if (hasWinner) ko[slotKey] = entry;
      }
    }

    console.log("Scored matches found: " + scored);
    // Safety: don't wipe Firebase if the feed returned suspiciously few results
    if (scored < 5) {
      console.log("WARNING: Only " + scored + " scored matches found — skipping write to protect existing data");
      return { statusCode: 200, body: JSON.stringify({ ok: true, scored, skipped: true }) };
    }
    await firebaseSet("scores", scores, token);
    await firebaseSet("goalscorers", goalscorers, token);
    const koCount = Object.keys(ko).length;
    if (koCount > 0) {
      await firebasePatch("ko", ko, token);
      console.log("Wrote " + koCount + " KO matches to ko node");
    }
    console.log("Sync complete - wrote " + scored + " scores");

    return { statusCode: 200, body: JSON.stringify({ ok: true, scored }) };
  } catch (err) {
    console.error("ERROR: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
