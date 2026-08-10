import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function environment(testRoot, extra = {}) {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    CODEX_ROUTER_LITELLM_BASE_URL: "",
    ...extra,
  };
}

test("LiteLLM endpoint persists outside the checkout and environment overrides it", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-endpoint-"));
  try {
    const env = environment(testRoot);
    const set = execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "set", "https://gateway.example/v1/"],
      { cwd: root, encoding: "utf8", env },
    );
    assert.match(set, /https:\/\/gateway\.example\/v1/);

    const settingsPath = path.join(testRoot, "state", "provider-endpoints.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.endpoints["litellm-gateway"], "https://gateway.example/v1");
    if (process.platform !== "win32") assert.equal(statSync(settingsPath).mode & 0o777, 0o600);

    const persisted = execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "status"],
      { cwd: root, encoding: "utf8", env },
    );
    assert.match(persisted, /https:\/\/gateway\.example\/v1/);
    assert.match(persisted, /protected local settings/);

    const overridden = execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "status"],
      {
        cwd: root,
        encoding: "utf8",
        env: environment(testRoot, { CODEX_ROUTER_LITELLM_BASE_URL: "https://temporary.example/openai/v1" }),
      },
    );
    assert.match(overridden, /https:\/\/temporary\.example\/openai\/v1/);
    assert.match(overridden, /not inherited by the background service/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("endpoint setup rejects credentials embedded in a URL and removal restores the default", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-endpoint-validation-"));
  try {
    const env = environment(testRoot);
    const rejected = spawnSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "set", "https://key:secret@gateway.example/v1"],
      { cwd: root, encoding: "utf8", env },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Do not put credentials/);

    execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "set", "https://gateway.example/v1"],
      { cwd: root, encoding: "utf8", env },
    );
    const removed = execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "remove"],
      { cwd: root, encoding: "utf8", env },
    );
    assert.match(removed, /http:\/\/127\.0\.0\.1:4000\/v1/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("support bundles redact a saved private gateway endpoint", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-endpoint-support-"));
  try {
    const env = environment(testRoot);
    execFileSync(
      process.execPath,
      ["src/provider-endpoint.mjs", "litellm-gateway", "set", "https://private.example/tenant/acme/v1"],
      { cwd: root, encoding: "utf8", env },
    );
    const output = path.join(testRoot, "support.json");
    execFileSync(
      process.execPath,
      ["src/support-bundle.mjs", "--output", output],
      { cwd: root, encoding: "utf8", env },
    );
    const bundle = readFileSync(output, "utf8");
    assert.doesNotMatch(bundle, /private\.example|tenant\/acme/);
    assert.match(bundle, /REDACTED_ENDPOINT/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
