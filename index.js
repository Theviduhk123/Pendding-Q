const axios = require("axios");

const GRAFANA_URL = "https://monitor-public.trax-cloud.com/api/datasources/proxy/29/render";
const SESSION_ID = "233f297590eb1d4840bc5e06eac86310";

const FIREBASE_URL = "https://sahiru-7a8a4-default-rtdb.firebaseio.com/data.json";

// ✅ only allow these tasks
const ALLOWED_TASKS = [
  "pricing_voting",
  "offline_pricing",
  "stitching",
  "masking",
  "masking_engine"
];

async function fetchAndPush() {
  try {
    const res = await axios.post(
      GRAFANA_URL,
      "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json",
      {
        headers: {
          "Cookie": `grafana_session=${SESSION_ID}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const data = res.data;

    let output = [];

    data.forEach(series => {
      const parts = series.target.split(".");

      if (parts.length < 6) return;

      const task = parts[4];
      const project = parts[5];

      // ❌ remove -sand projects
      if (project.includes("-sand")) return;

      // ❌ allow only selected tasks
      if (!ALLOWED_TASKS.includes(task)) return;

      const validPoints = series.datapoints.filter(dp => dp[0] !== null);
      if (validPoints.length === 0) return;

      const value = validPoints[validPoints.length - 1][0];

      output.push({ project, task, value });
    });

    // (optional) sort by value descending
    output.sort((a, b) => b.value - a.value);

    // push to Firebase
    await axios.put(FIREBASE_URL, output);

    console.log("✅ Updated Firebase:", new Date().toLocaleTimeString());

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// run every 30 seconds
setInterval(fetchAndPush, 30000);

// run immediately first time
fetchAndPush();
