const axios = require("axios");

const BASE_URL = "https://monitor-public.trax-cloud.com";
const FIND_URL = `${BASE_URL}/api/datasources/proxy/29/metrics/find`;
const USERNAME = "gss.kurunegala@gssintl.biz";
const PASSWORD = "Gssk@2021";

let SESSION_ID = null;

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
  console.log("Session OK");
}

// query = a Graphite metric path with wildcards, e.g. "prod.gauges.selector.queue.*"
async function findMetrics(query) {
  if (!SESSION_ID) await login();
  const res = await axios.get(FIND_URL, {
    params: { query },
    headers: {
      Cookie: `grafana_session=${SESSION_ID}`,
      "User-Agent": "Mozilla/5.0"
    }
  });
  return res.data; // array of { text, id, expandable, ... }
}

async function explore() {
  try {
    // Start broad and walk down. Adjust the starting query if your
    // root namespace isn't "prod".
    let level = "prod.*";
    console.log(`\n=== Level: ${level} ===`);
    let results = await findMetrics(level);
    console.table(results.map(r => ({ text: r.text, expandable: r.expandable })));

    // Then drill into "gauges" (or whatever shows up above) manually
    // by editing DRILL_PATH below and re-running, e.g.:
    // "prod.gauges.*"  ->  "prod.gauges.selector.*"  -> etc.
    const DRILL_PATH = process.argv[2]; // pass as command line arg
    if (DRILL_PATH) {
      console.log(`\n=== Level: ${DRILL_PATH} ===`);
      const drillResults = await findMetrics(DRILL_PATH);
      console.table(drillResults.map(r => ({ text: r.text, expandable: r.expandable })));
    }
  } catch (err) {
    console.error(err.response?.status, err.response?.data || err.message);
  }
}

explore();
