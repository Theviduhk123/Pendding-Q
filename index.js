const axios = require("axios");
const admin = require("firebase-admin");

// ✅ load firebase key from ENV (GitHub Secret)
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://sahiru-7a8a4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

const URL = "https://monitor-public.trax-cloud.com/api/datasources/proxy/29/render";
const SESSION_ID = "a06c0df22371f2040af8146afda4acaf";

async function fetchAndSave() {
  try {
    const res = await axios.post(
      URL,
      "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
      {
        headers: {
          "Cookie": `grafana_session=${SESSION_ID}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 15000
      }
    );

    const data = res.data;

    let output = [];

    data.forEach(series => {
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

    await db.ref("project_tasks").set({
      updatedAt: new Date().toISOString(),
      count: output.length,
      data: output
    });

    console.log("✅ Updated:", new Date().toISOString());

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    process.exit(1); // 👈 important for GitHub logs
  }
}

fetchAndSave();
