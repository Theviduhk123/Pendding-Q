const axios = require("axios");
const admin = require("firebase-admin");

// 🔥 Firebase (use your JSON file locally)
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sahiru-7a8a4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// 🔐 Grafana credentials (CHANGE THIS)
const GRAFANA_URL = "https://monitor-public.trax-cloud.com";
const USERNAME = "gss.colombo@gssintl.biz";
const PASSWORD = "GSS_TraxForm@2026";

const API_URL = `${GRAFANA_URL}/api/datasources/proxy/29/render`;

// 🔑 login → get session cookie
async function login() {
  try {
    const res = await axios.post(
      `${GRAFANA_URL}/login`,
      {
        user: USERNAME,
        password: PASSWORD
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        withCredentials: true
      }
    );

    const cookies = res.headers["set-cookie"];
    if (!cookies) throw new Error("No cookies received");

    const sessionCookie = cookies.find(c => c.includes("grafana_session"));

    if (!sessionCookie) throw new Error("Session cookie not found");

    return sessionCookie.split(";")[0]; // grafana_session=xxxx

  } catch (err) {
    console.error("❌ Login failed:", err.response?.data || err.message);
    throw err;
  }
}

// 📊 fetch data
async function fetchData(cookie) {
  const res = await axios.post(
    API_URL,
    "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
    {
      headers: {
        "Cookie": cookie,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 15000
    }
  );

  if (!Array.isArray(res.data)) {
    throw new Error("Invalid API response (not JSON)");
  }

  let output = [];

  res.data.forEach(series => {
    const parts = series.target.split(".");
    if (parts.length < 6) return;

    const task = parts[4];
    const project = parts[5];

    if (project.includes("-sand")) return;

    const validPoints = series.datapoints.filter(dp => dp[0] !== null);
    if (!validPoints.length) return;

    const value = validPoints[validPoints.length - 1][0];

    output.push({ project, task, value });
  });

  output.sort((a, b) => b.value - a.value);

  return output;
}

// 💾 save to Firebase
async function saveToFirebase(data) {
  await db.ref("project_tasks").set({
    updatedAt: new Date().toISOString(),
    count: data.length,
    data
  });
}

// 🔁 main loop
async function run() {
  try {
    const cookie = await login();
    const data = await fetchData(cookie);
    await saveToFirebase(data);

    console.log("✅ Updated:", new Date().toLocaleTimeString());

  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
}

// ⏱ run every 30 seconds
setInterval(run, 30000);

// run immediately
run();
