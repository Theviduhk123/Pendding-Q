const axios = require("axios");

const BASE_URL = "https://monitor-public.trax-cloud.com";
const RENDER_URL = `${BASE_URL}/api/datasources/proxy/29/render`;
const FIND_URL = `${BASE_URL}/api/datasources/proxy/29/metrics/find`;
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

// Keywords used to auto-detect the "oldest task" / duration metrics
// in the Graphite tree. Add more words here if your metric uses
// different naming (e.g. "age", "wait_time").
const OLDEST_KEYWORDS = ["oldest", "duration", "age"];

// Root to start exploring from. Narrow this down if you know more
// of the path already (e.g. "prod.gauges.selector.*") to speed things up.
const EXPLORE_ROOT = "prod.gauges.selector.*";
const MAX_DEPTH = 8;

let SESSION_ID = null;
let CACHED_OLDEST_TARGETS = null; // discovered once, reused every cycle

// ---------- AUTH ----------
async function login() {
  console.log("Logging into Grafana...");
  const res = await axios.post(
    `${BASE_URL}/login`,
    { user: USERNAME, password: PASSWORD },
    { maxRedirects: 0, validateStatus: status => status < 500 }
  );
  const cookies = res.headers["set-cookie"];
  if (!cookies) throw new Error("Login failed. No cookies returned.");
  const sessionCookie = cookies.find(c => c.startsWith("grafana_session="));
  if (!sessionCookie) throw new Error("grafana_session cookie not found.");
  SESSION_ID = sessionCookie.split(";")[0].replace("grafana_session=", "");
  console.log("New Session:", SESSION_ID);
}

async function authedGet(url, params) {
  if (!SESSION_ID) await login();
  try {
    const res = await axios.get(url, {
      params,
      headers: {
        Cookie: `grafana_session=${SESSION_ID}`,
        "User-Agent": "Mozilla/5.0"
      }
    });
    return res.data;
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      await login();
      const retry = await axios.get(url, {
        params,
        headers: {
          Cookie: `grafana_session=${SESSION_ID}`,
          "User-Agent": "Mozilla/5.0"
        }
      });
      return retry.data;
    }
    throw err;
  }
}

async function authedPost(url, body) {
  if (!SESSION_ID) await login();
  const headers = {
    Cookie: `grafana_session=${SESSION_ID}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0"
  };
  try {
    const res = await axios.post(url, body, { headers });
    return res.data;
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      await login();
      headers.Cookie = `grafana_session=${SESSION_ID}`;
      const retry = await axios.post(url, body, { headers });
      return retry.data;
    }
    throw err;
  }
}

// ---------- METRIC DISCOVERY ----------
async function findMetrics(query) {
  return authedGet(FIND_URL, { query });
}

// Recursively walk the metric tree under `path`, collecting leaf
// metrics whose full path contains one of OLDEST_KEYWORDS.
async function discoverOldestTargets(path, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;

  let nodes;
  try {
    nodes = await findMetrics(path);
  } catch (err) {
    console.error("metrics/find failed for", path, err.response?.status || err.message);
    return found;
  }

  for (const node of nodes) {
    const fullId = node.id || node.text;
    const isLeaf = node.expandable === 0 || node.expandable === false;

    if (isLeaf) {
      const lower = fullId.toLowerCase();
      if (OLDEST_KEYWORDS.some(k => lower.includes(k))) {
        found.push(fullId);
      }
    } else {
      // Only recurse into branches that look queue/task related,
      // to avoid exploring the entire unrelated metric tree.
      await discoverOldestTargets(`${fullId}.*`, depth + 1, found);
    }
  }
  return found;
}

async function getOldestTargets() {
  if (CACHED_OLDEST_TARGETS) return CACHED_OLDEST_TARGETS;
  console.log("Discovering oldest-task metric paths...");
  const found = await discoverOldestTargets(EXPLORE_ROOT);
  console.log(`Discovered ${found.length} candidate target(s):`, found);
  CACHED_OLDEST_TARGETS = found;
  return found;
}

// ---------- DATA FETCH ----------
async function fetchQueueTotals() {
  const body =
    "target=prod.gauges.selector.queue.*.*.total&from=-1h&until=now&format=json";
  return authedPost(RENDER_URL, body);
}

async function fetchSeriesForTargets(targets) {
  if (!targets.length) return [];
  const body =
    targets.map(t => `target=${encodeURIComponent(t)}`).join("&") +
    "&from=-1h&until=now&format=json";
  return authedPost(RENDER_URL, body);
}

// ---------- PARSING ----------
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

// Generic parser for discovered oldest/duration metrics.
// Keeps the raw target path since structure is unknown, plus tries
// to extract project/task if the path matches the usual pattern.
function parseOldestSeries(data) {
  let output = [];
  data.forEach(series => {
    const validPoints = series.datapoints.filter(dp => dp[0] !== null);
    if (!validPoints.length) return;

    const parts = series.target.split(".");
    // best-effort guesses; may not apply to every discovered metric
    const task = parts.length >= 5 ? parts[parts.length - 3] : null;
    const project = parts.length >= 5 ? parts[parts.length - 2] : null;

    output.push({
      target: series.target,
      project,
      task,
      durationSeconds: validPoints[validPoints.length - 1][0]
    });
  });
  output.sort((a, b) => b.durationSeconds - a.durationSeconds);
  return output;
}

function splitByCloud(entries) {
  const aws = entries.filter(e => e.target.toLowerCase().includes("aws"));
  const gcp = entries.filter(e => e.target.toLowerCase().includes("gcp"));
  const other = entries.filter(
    e => !e.target.toLowerCase().includes("aws") && !e.target.toLowerCase().includes("gcp")
  );
  return { aws, gcp, other };
}

// ---------- MAIN ----------
async function fetchAndPush() {
  try {
    const queueData = await fetchQueueTotals();
    const queueTotals = parseQueueSeries(queueData);

    const oldestTargets = await getOldestTargets();
    const oldestData = await fetchSeriesForTargets(oldestTargets);
    const oldestParsed = parseOldestSeries(oldestData);
    const { aws, gcp, other } = splitByCloud(oldestParsed);

    const payload = {
      queueTotals,
      awsOldestTask: aws,
      gcpOldestTask: gcp,
      otherOldestTask: other, // in case cloud can't be detected from path
      updatedAt: new Date().toISOString()
    };

    await axios.put(FIREBASE_URL, payload);

    console.log(
      `Updated Firebase (queue:${queueTotals.length}, aws:${aws.length}, gcp:${gcp.length}, other:${other.length})`,
      new Date().toLocaleTimeString()
    );
  } catch (err) {
    console.error(err.response?.status, err.message);
  }
}

fetchAndPush();
setInterval(fetchAndPush, 30000);
