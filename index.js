const axios = require("axios");

const BASE_URL = "https://monitor-public.trax-cloud.com";
const GRAFANA_URL = `${BASE_URL}/api/datasources/proxy/29/render`;
const USERNAME = "gss.kurunegala@gssintl.biz";
const PASSWORD = "Gssk@2021";
const FIREBASE_URL =
  "https://sahiru-7a8a4-default-rtdb.firebaseio.com/data.json";

const ALLOWED_TASKS = [
  "pricing_voting",
  "offline_pricing",
  "stitching",
  "masking",
  "masking_price_labels",
  "masking_engine"
];

// ============================================================
// TODO: Replace these with your ACTUAL Graphite target strings
// for "oldest task in queue", per cloud. Check your Grafana
// panel's query editor (View panel JSON / query inspector) to
// get the exact metric path pattern for AWS and GCP.
//
// These are placeholders based on your existing queue.total
// pattern — they will almost certainly need adjusting.
// ============================================================
const AWS_OLDEST_TARGET =
  "aws.prod.gauges.selector.queue.*.*.oldest";
const GCP_OLDEST_TARGET =
  "gcp.prod.gauges.selector.queue.*.*.oldest";

let SESSION_ID = null;

// Login and get grafana_session cookie
async function login() {
  console.log("Logging into Grafana...");
  const res = await axios.post(
    `${BASE_URL}/login`,
    {
      user: USERNAME,
      password: PASSWORD
    },
    {
      maxRedirects: 0,
      validateStatus: status => status < 500
    }
  );
  const cookies = res.headers["set-cookie"];
  if (!cookies) {
    throw new Error("Login failed. No cookies returned.");
  }
  const sessionCookie = cookies.find(c =>
    c.startsWith("grafana_session=")
  );
  if (!sessionCookie) {
    throw new Error("grafana_session cookie not found.");
  }
  SESSION_ID = sessionCookie
    .split(";")[0]
    .replace("grafana_session=", "");
  console.log("New Session:", SESSION_ID);
}

// Generic query runner with session/retry handling
async function queryGrafana(target, from = "-1h", until = "now") {
  if (!SESSION_ID) {
    await login();
  }
  const body = `target=${encodeURIComponent(
    target
  )}&from=${from}&until=${until}&format=json`;

  try {
    const res = await axios.post(GRAFANA_URL, body, {
      headers: {
        Cookie: `grafana_session=${SESSION_ID}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"
      }
    });
    return res.data;
  } catch (err) {
    if (
      err.response &&
      (err.response.status === 401 || err.response.status === 403)
    ) {
      console.log("Session expired. Logging in again...");
      await login();
      const retry = await axios.post(GRAFANA_URL, body, {
        headers: {
          Cookie: `grafana_session=${SESSION_ID}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0"
        }
      });
      return retry.data;
    }
    throw err;
  }
}

// Existing queue.total fetch
async function fetchQueueTotals() {
  return queryGrafana(
    "prod.gauges.selector.queue.*.*.total",
    "-1h",
    "now"
  );
}

// Parse a queue-total-style series into { project, task, value }
function parseQueueSeries(data) {
  let output = [];
  data.forEach(series => {
    const parts = series.target.split(".");
    if (parts.length < 6) return;
    const task = parts[4];
    const project = parts[5];
    if (project.includes("-sand")) return;
    if (!ALLOWED_TASKS.includes(task)) return;
    const validPoints = series.datapoints.filter(dp => dp[0] !== null);
    if (!validPoints.length) return;
    output.push({
      project,
      task,
      value: validPoints[validPoints.length - 1][0]
    });
  });
  output.sort((a, b) => b.value - a.value);
  return output;
}

// Parse an "oldest task" style series into { project, task, oldestAgeSeconds }
// TODO: adjust the index of `task` / `project` below once you confirm
// the real target path structure for AWS/GCP oldest metrics.
function parseOldestSeries(data) {
  let output = [];
  data.forEach(series => {
    const parts = series.target.split(".");
    if (parts.length < 6) return;
    const task = parts[4];
    const project = parts[5];
    if (project.includes("-sand")) return;
    if (!ALLOWED_TASKS.includes(task)) return;
    const validPoints = series.datapoints.filter(dp => dp[0] !== null);
    if (!validPoints.length) return;
    output.push({
      project,
      task,
      oldestAgeSeconds: validPoints[validPoints.length - 1][0]
    });
  });
  // Oldest first = highest age first
  output.sort((a, b) => b.oldestAgeSeconds - a.oldestAgeSeconds);
  return output;
}

async function fetchAndPush() {
  try {
    const [queueData, awsOldestData, gcpOldestData] = await Promise.all([
      fetchQueueTotals(),
      queryGrafana(AWS_OLDEST_TARGET, "-1h", "now"),
      queryGrafana(GCP_OLDEST_TARGET, "-1h", "now")
    ]);

    const queueTotals = parseQueueSeries(queueData);
    const awsOldest = parseOldestSeries(awsOldestData);
    const gcpOldest = parseOldestSeries(gcpOldestData);

    const payload = {
      queueTotals,
      awsOldestTask: awsOldest,
      gcpOldestTask: gcpOldest,
      updatedAt: new Date().toISOString()
    };

    await axios.put(FIREBASE_URL, payload);

    console.log(
      `Updated Firebase (queue:${queueTotals.length}, aws:${awsOldest.length}, gcp:${gcpOldest.length})`,
      new Date().toLocaleTimeString()
    );
  } catch (err) {
    console.error(err.response?.status, err.message);
  }
}

fetchAndPush();
setInterval(fetchAndPush, 30000);
