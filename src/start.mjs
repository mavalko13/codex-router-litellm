import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  AUTO_CURATE_PENDING_PATH,
  autoCurateRefreshPending,
  clearAutoCurateRefreshPending,
  periodicAutoCurateAction,
} from "./auto-curate-state.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { waitForHealth as pollHealth } from "./health-probe.mjs";

function resolveLiteLlmBinary() {
  return (
    process.env.MODEL_ROUTER_LITELLM_BIN ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN
      : undefined) ||
    path.join(
      SOURCE_ROOT,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "litellm.exe" : "litellm",
    )
  );
}

if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error(`Internal service key is missing; run ./bin/install.`);
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error(`Router caller key is missing; run ./bin/install.`);
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(
  readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
);

const AUTO_CURATE_SCRIPT = path.join(SOURCE_ROOT, "src", "auto-curate-models.mjs");
const CATALOG_SCRIPT = path.join(SOURCE_ROOT, "src", "catalog.mjs");
const DEFAULT_AUTO_CURATE_INTERVAL_MS = 5 * 60_000;
const MIN_AUTO_CURATE_INTERVAL_MS = 60_000;

function parseAutoCurateSummary(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    return Number.isInteger(parsed?.added) && parsed.added >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function runAutoCurateSync() {
  const result = spawnSync(process.execPath, [AUTO_CURATE_SCRIPT], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024,
  });
  const summary = result.status === 0 ? parseAutoCurateSummary(result.stdout) : undefined;
  return { ok: Boolean(summary), added: summary?.added || 0 };
}

function autoCurateIntervalMs() {
  const configured = process.env.MODEL_ROUTER_AUTO_CURATE_INTERVAL_MS;
  if (configured === undefined || configured === "") return DEFAULT_AUTO_CURATE_INTERVAL_MS;
  const value = Number(configured);
  if (value === 0) return 0;
  if (Number.isInteger(value) && value >= MIN_AUTO_CURATE_INTERVAL_MS) return value;
  console.error(
    `[model-router] invalid MODEL_ROUTER_AUTO_CURATE_INTERVAL_MS; using ${DEFAULT_AUTO_CURATE_INTERVAL_MS}`,
  );
  return DEFAULT_AUTO_CURATE_INTERVAL_MS;
}

const startupAutoCurate = runAutoCurateSync();
if (!startupAutoCurate.ok) {
  if (!existsSync(MERGED_CATALOG_PATH)) {
    throw new Error("Automatic model discovery failed and no existing catalog is available.");
  }
  console.error(
    "[model-router] automatic model discovery failed; continuing with the existing local catalog",
  );
}
if (existsSync(AUTO_CURATE_PENDING_PATH)) {
  const catalogRefresh = spawnSync(
    process.execPath,
    [CATALOG_SCRIPT],
    { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit" },
  );
  if (catalogRefresh.status === 0) {
    clearAutoCurateRefreshPending();
  } else {
    if (!existsSync(MERGED_CATALOG_PATH)) {
      throw new Error("Codex model catalog refresh failed and no existing catalog is available.");
    }
    console.error(
      "[model-router] catalog refresh failed; continuing with the existing local catalog",
    );
  }
}

const { localLiteLlmRequiredForSelection } = await import("./local-litellm-mode.mjs");
const localLiteLlmRequired = localLiteLlmRequiredForSelection();
const litellm = localLiteLlmRequired ? resolveLiteLlmBinary() : undefined;
if (localLiteLlmRequired && !existsSync(litellm)) {
  throw new Error(`LiteLLM is not installed at ${litellm}; run ./bin/install.`);
}
if (localLiteLlmRequired) {
  // Publish routes before the picker. If catalog generation fails, an older
  // picker remains a safe subset of the fresh routes; the inverse would expose
  // a model that the running LiteLLM process cannot route.
  const { writeLiteLlmConfig } = await import("./litellm-config.mjs");
  writeLiteLlmConfig();
}

const commonEnv = {
  MODEL_ROUTER_TARGET: TARGET,
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  MODEL_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  // LiteLLM's ollama_chat provider talks to the daemon root, not the
  // OpenAI-compatible /v1 surface the bridge uses for inference.
  MODEL_ROUTER_LOCAL_BASE_URL_ROOT:
    (process.env.MODEL_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, ""),
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
  GROK_OAUTH_FORWARD_BASE_URL: loopback(PORTS.grokOauth, "/v1"),
  MODEL_ROUTER_QUIET: "1",
  MODEL_ROUTER_LOCAL_LITELLM_ENABLED: localLiteLlmRequired ? "1" : "0",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: loopback(PORTS.api),
  CODEX_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  CODEX_ROUTER_LOCAL_LITELLM_ENABLED: localLiteLlmRequired ? "1" : "0",
  CODEX_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  CODEX_ROUTER_PORT: String(PORTS.router),
  LITELLM_MASTER_KEY: internalKey,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  NO_COLOR: "1",
  // LiteLLM prints Unicode banners at startup; on a non-UTF-8 Windows code page
  // (e.g. cp1252) that raises UnicodeEncodeError and the child never comes up.
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

const children = [];
let shuttingDown = false;
let restartRequested = false;
let autoCurateTimer;
let autoCurateChild;

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...commonEnv, ...extraEnv },
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ label, code, signal }));
  });
}

// The probe loop lives in src/health-probe.mjs so it can be tested directly;
// importing this file starts the whole service pipeline.
function waitForHealth(label, url, headers = {}, timeoutMs = 30_000, expectedService, child) {
  return pollHealth({
    label,
    url,
    headers,
    timeoutMs,
    expectedService,
    child,
    isShuttingDown: () => shuttingDown,
  });
}

function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (autoCurateTimer) clearInterval(autoCurateTimer);
  if (
    autoCurateChild &&
    autoCurateChild.exitCode === null &&
    autoCurateChild.signalCode === null
  ) {
    autoCurateChild.kill("SIGTERM");
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 3_000).unref();
}

function runPeriodicAutoCurate() {
  if (shuttingDown || autoCurateChild) return;
  const child = spawn(process.execPath, [AUTO_CURATE_SCRIPT], {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  autoCurateChild = child;
  let stdout = "";
  let overflow = false;
  let spawnFailed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > 1024 * 1024) {
      overflow = true;
      return;
    }
    stdout += chunk;
  });
  child.once("error", () => {
    spawnFailed = true;
  });
  // `close` follows both a normal exit and a spawn error. Using it rather than
  // `exit` ensures a failed spawn releases the overlap guard for the next
  // interval on every platform.
  child.once("close", (code) => {
    if (autoCurateChild === child) autoCurateChild = undefined;
    if (shuttingDown) return;
    if (spawnFailed) {
      console.error("[model-router] periodic automatic model discovery could not be started");
      return;
    }
    const summary = !overflow && code === 0 ? parseAutoCurateSummary(stdout) : undefined;
    const pending = autoCurateRefreshPending();
    const action = periodicAutoCurateAction({ summary, pending });
    if (action === "failed") {
      console.error(
        "[model-router] periodic automatic model discovery failed; keeping the existing catalog",
      );
      return;
    }
    if (action === "idle") return;
    restartRequested = true;
    const metadataNote = summary?.metadataChanged ? " and live metadata changes" : "";
    console.error(
      `[model-router] ${summary?.added || 0} new model(s)${metadataNote} await publication; restarting the local router stack to publish routes and catalog`,
    );
    stopChildren();
  });
}

function startPeriodicAutoCurate() {
  const intervalMs = autoCurateIntervalMs();
  if (intervalMs === 0) return;
  autoCurateTimer = setInterval(runPeriodicAutoCurate, intervalMs);
  autoCurateTimer.unref();
}

const FRONTEND = { script: "router.mjs", service: "codex-router", label: "Codex router" };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

async function main() {
  const kimiForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "oauth-forwarder.mjs")]);
  await waitForHealth("OAuth forwarder", loopback(PORTS.oauth, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, kimiForwarder);

  const api = run(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")]);
  await waitForHealth("API forwarder", loopback(PORTS.api, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, api);

  const grokForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "grok-oauth-forwarder.mjs")]);
  await waitForHealth("Grok OAuth forwarder", loopback(PORTS.grokOauth, "/health"), {
    Authorization: `Bearer ${internalKey}`,
  }, 30_000, undefined, grokForwarder);

  let gateway;
  if (localLiteLlmRequired) {
    gateway = run(litellm, [
      "--config",
      LITELLM_CONFIG_PATH,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.gateway),
    ]);
    // LiteLLM cold starts can take minutes when launchd starves the job under
    // system load; killing it mid-import restarts the import from scratch and
    // the service loops forever, so wait long enough for a starved import.
    await waitForHealth(
      "LiteLLM gateway",
      loopback(PORTS.gateway, "/health/liveliness"),
      { Authorization: `Bearer ${internalKey}` },
      300_000,
      undefined,
      gateway,
    );
  }

  const frontend = FRONTEND;
  const frontendService = frontend.service;
  const router = run(process.execPath, [path.join(SOURCE_ROOT, "src", frontend.script)]);
  await waitForHealth(
    frontend.label,
    loopback(PORTS.router, "/health"),
    {},
    30_000,
    frontendService,
    router,
  );

  console.error(`[${frontendService}] ready (authenticated loopback endpoint)`);
  startPeriodicAutoCurate();
  const result = await Promise.race([
    waitForExit(kimiForwarder, "OAuth forwarder"),
    waitForExit(api, "API forwarder"),
    waitForExit(grokForwarder, "Grok OAuth forwarder"),
    ...(gateway ? [waitForExit(gateway, "LiteLLM gateway")] : []),
    waitForExit(router, frontend.label),
  ]);
  if (!shuttingDown) {
    console.error(
      `[${frontendService}] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
    );
  }
  return restartRequested ? 75 : result.code || 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = (error instanceof Error && error.message) || String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    exitCode = 1;
  }
} finally {
  stopChildren();
  await Promise.all(children.map((child) => waitForExit(child, "child")));
}
process.exit(exitCode);
