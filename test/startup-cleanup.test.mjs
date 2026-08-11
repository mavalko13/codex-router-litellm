import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// On loopback this settles either way in microseconds: a live listener accepts,
// and a closed port refuses. A socket that does neither is not a third answer
// this test can interpret, so bound it rather than letting it hang until the
// outer test timeout turns a clear result into a mystery.
const PORT_PROBE_TIMEOUT_MS = 2_000;

async function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(false));
    socket.once("error", () => settle(true));
  });
}

// Startup is a pipeline of five sequential child spawns, each gated on an HTTP
// health probe that backs off from 200 ms to a 2 s cap between refused probes
// and widens the probe window itself from 1 s to a 10 s cap. That makes the run
// time depend on how fast this machine can fork and schedule processes, not on
// the behaviour under test: measured end-to-end at ~1.2 s idle, ~1.5 s under 2x
// CPU oversubscription, and ~18.6 s when a concurrent fork storm made spawns
// slow enough that live-but-starved servers kept blowing the probe abort. (That
// fork-storm figure predates the widening window, which is what stopped those
// starved servers being declared dead outright -- but the run time still tracks
// machine speed.) A single fixed budget for the whole pipeline therefore races
// machine speed, which is why 10 s failed on a busy machine while startup was
// working perfectly.
//
// Progress, not elapsed time, separates "slow" from "stuck": every stage
// announces itself on the child's stderr ("[kimi-oauth] listening", the
// gateway's spawn error, "startup failed"). Waiting on that observable signal
// and failing only once it stops arriving keeps the guard against a hang while
// letting a loaded machine take as long as it needs, and the budget no longer
// accumulates across stages.
//
// 30 s is ~2x the worst single-stage silence observed in a run that still
// produced the correct result (16.3 s, under the fork storm above). It stays
// meaningful because start.mjs self-limits every wait -- 30 s per forwarder,
// 300 s for the gateway -- so the only silence this can catch is the gateway's,
// and it reports it 270 s sooner than start.mjs would.
const STARTUP_STALL_MS = 30_000;

// Fails only if the child produces no output at all for STARTUP_STALL_MS and
// has not exited. Resolves as soon as it exits, however long that takes.
function waitForStartupExit(child, readErrors) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let lastOutput = started;
    const onProgress = () => {
      lastOutput = Date.now();
    };
    child.stderr.on("data", onProgress);
    const finish = () => {
      clearInterval(watchdog);
      child.stderr.off("data", onProgress);
    };
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastOutput;
      if (idleMs < STARTUP_STALL_MS) return;
      finish();
      reject(
        new Error(
          `startup stalled: no output for ${idleMs} ms after waiting ${Date.now() - started} ms in total; stderr so far:\n${readErrors()}`,
        ),
      );
    }, 250);
    child.once("exit", (code, signal) => {
      finish();
      resolve({ code, signal });
    });
  });
}

async function waitForStartupHealth(url, child, readErrors) {
  const deadline = Date.now() + STARTUP_STALL_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`startup exited early (${child.exitCode}):\n${readErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Service not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}:\n${readErrors()}`);
}

// The stall watchdog is the real guard and gives a diagnosable message; this
// outer timeout only backstops a child that hangs while still chattering. It
// has to clear a loaded run (~19 s) plus one full stall window (30 s), so 20 s
// was actually below the floor for reporting a stall at all. A passing run is
// unaffected -- this bound is only reached when something is already broken.
test("startup failure terminates services that already became healthy", { timeout: 120_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-startup-cleanup-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "startup-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), "startup-caller-key-with-sufficient-length\n", { mode: 0o600 });

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_LITELLM_BIN: process.execPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const exit = await waitForStartupExit(child, () => errors);
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 1, errors);
    assert.match(errors, /\[model-router\] startup failed/);
    assert.match(
      errors,
      /startup failed: LiteLLM gateway exited before becoming healthy\./,
    );
    assert.doesNotMatch(errors, /startup-internal-key-with-sufficient-length/);
    assert.doesNotMatch(errors, /startup-caller-key-with-sufficient-length/);
    for (const port of [oauthPort, apiPort, grokOauthPort]) {
      assert.equal(await portIsClosed(port), true, `orphaned child still owns port ${port}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("startup skips local LiteLLM with an exclusive litellm-gateway Chat model selection", { timeout: 120_000 }, async () => {
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-startup-direct-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "startup-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), "startup-caller-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["litellm-gateway"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "litellm-gateway-api-key.secret"), "test-virtual-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "user-models.json"),
    `${JSON.stringify({
      version: 1,
      models: [
        {
          slug: "litellm-gateway/ollama-cloud-kimi-k2-7-code",
          gatewayModel: "litellm-gateway-ollama-cloud-kimi-k2-7-code",
          upstreamModel: "ollama-cloud-kimi-k2-7-code",
          provider: "litellm-gateway",
          listed: true,
          apiSurface: "chat-completions",
          displayName: "Kimi Code",
          description: "External LiteLLM gateway Chat model.",
          priority: 1,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text"],
          compHash: "litellm-gateway-ollama-cloud-kimi-k2-7-code-test",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_AUTO_CURATE_INTERVAL_MS: "0",
      MODEL_ROUTER_LITELLM_BIN: path.join(rootDir, "missing-litellm"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    await waitForStartupHealth(`http://127.0.0.1:${routerPort}/health`, child, () => errors);
    const response = await fetch(
      `${callerBaseUrl(routerPort, "startup-caller-key-with-sufficient-length")}/health`,
    );
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const payload = JSON.parse(body);
    assert.equal(payload.gateway.enabled, false);
    assert.equal(await portIsClosed(gatewayPort), true);
    assert.doesNotMatch(errors, /LiteLLM is not installed/);
    assert.doesNotMatch(errors, /LiteLLM gateway/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForStartupExit(child, () => errors).catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
  }
});
