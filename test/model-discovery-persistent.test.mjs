import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("automatic discovery ignores an environment key and uses the saved restricted key", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "discovery-persistent-key-"));
  const savedKey = "saved-restricted-test-key";
  const environmentKey = "environment-master-test-key";
  let request;

  try {
    writeFileSync(
      path.join(stateDir, "example-litellm-api-key.secret"),
      `${savedKey}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "providers.json"), JSON.stringify({
      version: 1,
      providers: [{
        id: "example-litellm",
        displayName: "Example LiteLLM",
        ownedBy: "test",
        kind: "openai-compatible",
        baseUrl: "https://fixture.invalid/v1",
        baseUrlEnv: "EXAMPLE_LITELLM_BASE_URL",
        credential: {
          environment: ["EXAMPLE_LITELLM_API_KEY"],
          file: "example-litellm-api-key.secret",
        },
      }],
    }));
    writeFileSync(path.join(stateDir, "provider-endpoints.json"), JSON.stringify({
      version: 1,
      endpoints: { "example-litellm": "https://saved-fixture.invalid/v1" },
    }));
    process.env.MODEL_ROUTER_STATE_DIR = stateDir;
    process.env.MODEL_ROUTER_REGISTRY = path.join(stateDir, "providers.json");
    process.env.EXAMPLE_LITELLM_API_KEY = environmentKey;
    process.env.EXAMPLE_LITELLM_BASE_URL = "https://environment-fixture.invalid/v1";
    const { discoverProviderModels } = await import("../src/model-discovery.mjs");
    const result = await discoverProviderModels("example-litellm", {
      persistentCredential: true,
      timeoutMs: 2_000,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response('{"data":[{"id":"live-model"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(result.discovered, ["live-model"]);
    assert.equal(request.url, "https://saved-fixture.invalid/v1/models");
    assert.equal(request.options.headers.Authorization, `Bearer ${savedKey}`);
    assert.notEqual(request.options.headers.Authorization, `Bearer ${environmentKey}`);
  } finally {
    delete process.env.EXAMPLE_LITELLM_API_KEY;
    delete process.env.EXAMPLE_LITELLM_BASE_URL;
    delete process.env.MODEL_ROUTER_STATE_DIR;
    delete process.env.MODEL_ROUTER_REGISTRY;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("provider error bodies never reach discovery errors", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "discovery-redaction-"));
  try {
    process.env.MODEL_ROUTER_STATE_DIR = stateDir;
    process.env.EXAMPLE_LITELLM_API_KEY = "environment-test-key";
    process.env.EXAMPLE_LITELLM_BASE_URL = "https://fixture.invalid/v1";
    const moduleUrl = new URL(`../src/model-discovery.mjs?redaction=${Date.now()}`, import.meta.url);
    const { discoverProviderModels } = await import(moduleUrl);
    await assert.rejects(
      discoverProviderModels("example-litellm", {
        fetchImpl: async () =>
          new Response(
            '{"error":{"message":"budget exceeded for sk-secret-fragment account@example.test"}}',
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      }),
      (error) => {
        assert.equal(error.message, "Provider model discovery returned HTTP 429.");
        assert.doesNotMatch(error.message, /secret-fragment|example\.test|budget exceeded/);
        return true;
      },
    );
  } finally {
    delete process.env.EXAMPLE_LITELLM_API_KEY;
    delete process.env.EXAMPLE_LITELLM_BASE_URL;
    delete process.env.MODEL_ROUTER_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
