require("dotenv").config();

const axios = require("axios");
const admin = require("firebase-admin");

// Firebase
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sahiru-7a8a4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

const BASE_URL = "https://monitor-public.trax-cloud.com";
const API_URL = `${BASE_URL}/api/datasources/proxy/29/render`;

const USER = process.env.GRAFANA_USER;
const PASS = process.env.GRAFANA_PASS;

async function login() {
  const res = await axios.post(
    `${BASE_URL}/login`,
    { user: USER, password: PASS },
    { withCredentials: true }
  );

  const cookie = res.headers["set-cookie"]
    ?.find(c => c.includes("grafana_session"));

  if (!cookie) throw new Error("Login failed (no session)");

  return cookie.split(";")[0];
}

async function fetchData(cookie) {
  const res = await axios.post(
    API_URL,
    "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
    {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  if (!Array.isArray(res.data)) {
    throw new Error("Invalid response (not JSON)");
  }

  let output = [];

  res.data.forEach(s => {
    const p = s.target.split(".");
    if (p.length < 6) return;

    const task = p[4];
    const project = p[5];

    if (project.includes("-sand")) return;

    const valid = s.datapoints.filter(d => d[0] !== null);
    if (!valid.length) return;

    output.push({
      project,
      task,
      value: valid.at(-1)[0]
    });
  });

  output.sort((a, b) => b.value - a.value);

  return output;
}

async function run() {
  try {
    const cookie = await login();
    const data = await fetchData(cookie);

    await db.ref("project_tasks").set({
      updatedAt: new Date().toISOString(),
      data
    });

    console.log("✅ Updated:", new Date().toLocaleTimeString());

  } catch (e) {
    console.error("❌ ERROR:", e.message);
  }
}

// every 30 sec
setInterval(run, 30000);
run();
