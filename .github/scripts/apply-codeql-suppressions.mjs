import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DISMISSAL_COMMENT = "Suppressed via SARIF";
const POLL_INTERVAL_MS = 5_000;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1_000;

const [sarifDirectory] = process.argv.slice(2);
const requiredEnvironment = [
  "SARIF_ID",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_API_URL",
];

if (!sarifDirectory || requiredEnvironment.some((name) => !process.env[name])) {
  throw new Error(
    `Usage: ${process.argv[1]} <sarif-directory>; required environment: ${requiredEnvironment.join(", ")}`,
  );
}

const apiUrl = process.env.GITHUB_API_URL.replace(/\/$/, "");
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function waitForSarif() {
  const url = `${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}/code-scanning/sarifs/${process.env.SARIF_ID}`;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (true) {
    const { processing_status: status } = await (await request(url)).json();
    if (status === "complete") return;
    if (status === "failed") throw new Error(`SARIF upload ${process.env.SARIF_ID} failed to process.`);
    if (Date.now() >= deadline) throw new Error(`SARIF upload ${process.env.SARIF_ID} did not finish processing.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function sarifFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sarifFiles(target));
    else if (entry.isFile() && (entry.name.endsWith(".sarif") || entry.name.endsWith(".sarif.json"))) files.push(target);
  }
  return files;
}

function sourcePath(uri) {
  const decoded = decodeURIComponent(uri).replace(/^file:\/\//, "");
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace && path.isAbsolute(decoded)) return path.relative(workspace, decoded).split(path.sep).join("/");
  return decoded.replace(/^\.\//, "");
}

function resultLocation(result) {
  const location = result.locations?.[0]?.physicalLocation;
  const region = location?.region;
  if (!result.ruleId || !location?.artifactLocation?.uri || !Number.isInteger(region?.startLine)) return null;
  return [result.ruleId, sourcePath(location.artifactLocation.uri), region.startLine, region.startColumn ?? null].join("\u0000");
}

async function sourceLocations() {
  const suppressed = new Set();
  const normal = new Set();
  const files = await sarifFiles(sarifDirectory);
  if (!files.length) throw new Error(`No SARIF files found in ${sarifDirectory}.`);

  for (const file of files) {
    const sarif = JSON.parse(await readFile(file, "utf8"));
    for (const run of sarif.runs ?? []) {
      for (const result of run.results ?? []) {
        const location = resultLocation(result);
        if (!location) continue;
        if (result.suppressions?.length) suppressed.add(location);
        else normal.add(location);
      }
    }
  }
  // A suppression wins when duplicate SARIF results describe the same source location.
  for (const location of suppressed) normal.delete(location);
  return { suppressed, normal };
}

function alertLocation(alert) {
  const location = alert.most_recent_instance?.location;
  if (!alert.rule?.id || !location?.path || !Number.isInteger(location.start_line)) return null;
  return [alert.rule.id, location.path, location.start_line, location.start_column ?? null].join("\u0000");
}

async function alerts(state) {
  const found = [];
  let url = `${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}/code-scanning/alerts?state=${state}&tool_name=CodeQL&per_page=100`;
  while (url) {
    const response = await request(url);
    found.push(...await response.json());
    const next = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/);
    url = next?.[1] ?? null;
  }
  return found;
}

async function updateAlert(number, body) {
  await request(`${apiUrl}/repos/${process.env.GITHUB_REPOSITORY}/code-scanning/alerts/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

await waitForSarif();
const { suppressed, normal } = await sourceLocations();
const [openAlerts, dismissedAlerts] = await Promise.all([alerts("open"), alerts("dismissed")]);

let dismissed = 0;
for (const alert of openAlerts) {
  if (suppressed.has(alertLocation(alert))) {
    await updateAlert(alert.number, {
      state: "dismissed",
      dismissed_reason: "won't fix",
      dismissed_comment: DISMISSAL_COMMENT,
    });
    dismissed += 1;
  }
}

let reopened = 0;
for (const alert of dismissedAlerts) {
  if (alert.dismissed_comment === DISMISSAL_COMMENT && normal.has(alertLocation(alert))) {
    await updateAlert(alert.number, { state: "open" });
    reopened += 1;
  }
}

console.log(`CodeQL source suppressions applied: dismissed ${dismissed}, reopened ${reopened}.`);
