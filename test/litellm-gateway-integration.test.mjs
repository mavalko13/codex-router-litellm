import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "litellm-gateway-integration-"));
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.CODEX_ROUTER_LITELLM_API_KEY = "test-virtual-key";
process.env.CODEX_ROUTER_LITELLM_BASE_URL = "";

const { PROVIDERS } = await import("../src/model-registry.mjs");
const { discoverProviderModels } = await import("../src/model-discovery.mjs");
const { writeProviderEndpoint } = await import("../src/provider-endpoints.mjs");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("a saved LiteLLM endpoint and virtual key drive live model discovery", async () => {
  let observedAuthorization;
  let observedPath;
  const server = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization;
    observedPath = request.url;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "team-model" }, { id: "coding-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    writeProviderEndpoint(
      PROVIDERS.get("litellm-gateway"),
      `http://127.0.0.1:${address.port}/v1`,
    );
    const result = await discoverProviderModels("litellm-gateway");
    assert.deepEqual(result.discovered, ["coding-model", "team-model"]);
    assert.deepEqual(result.registered, []);
    assert.equal(observedPath, "/v1/models");
    assert.equal(observedAuthorization, "Bearer test-virtual-key");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
