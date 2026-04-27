require("dotenv").config();

const axios = require("axios");
const admin = require("firebase-admin");

// 🔥 Firebase
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sahiru-7a8a4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// 🔐 credentials from .env
const USERNAME = process.env.GRAFANA_USER;
const PASSWORD = process.env.GRAFANA_PASS;

const BASE_URL = "https://monitor-public.trax-cloud.com";
const API_URL = `${BASE_URL}/api/datasources/proxy/29/render`;

// 🔑 login
async function login() {
  const res = await axios.post(
    `${BASE_URL}/login`,
    {
      user: USERNAME,
      password: PASSWORD
    },
    {
      headers: { "Content-Type": "application/json" },
      withCredentials: true
    }
  );

  const cookies = res.headers["set-cookie"];
  if (!cookies) throw new Error("No cookies received");

  const session = cookies.find(c => c.includes("grafana_session"));
  if (!session) throw new Error("No grafana session");

  return session.split(";")[0];
}

// 📊 fetch
async function fetchData(cookie) {
  const res = await axios.post(
    API_URL,
    "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
    {
      headers: {
        "Cookie": cookie,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  let output = [];

  res.data.forEach(series => {
    const parts = series.target.split(".");
    if (parts.length < 6) return;

    const task = parts[4];
    const project = parts[5];

    if (project.includes("-sand")) return;

    const valid = series.datapoints.filter(d => d[0] !== null);
    if (!valid.length) return;

    const value = valid[valid.length - 1][0];

    output.push({ project, task, value });
  });

  output.sort((a, b) => b.value - a.value);

  return output;
}

// 💾 save
async function save(data) {
  await db.ref("project_tasks").set({
    updatedAt: new Date().toISOString(),
    data
  });
}

// 🔁 run
async function run() {
  try {
    const cookie = await login();
    const data = await fetchData(cookie);
    await save(data);

    console.log("✅ Updated:", new Date().toLocaleTimeString());

  } catch (e) {
    console.error("❌ ERROR:", e.message);
  }
}

// ⏱ every 30 sec
setInterval(run, 30000);

// run first time
run();
