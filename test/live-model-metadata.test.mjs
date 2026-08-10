import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyLiveModelMetadata,
  mergeLiveProviderMetadata,
  providerSourceHash,
  readLiveModelMetadata,
  writeLiveModelMetadata,
} from "../src/live-model-metadata.mjs";
import {
  boundedModelListJson,
  modelMetadataFromPayload,
} from "../src/model-discovery.mjs";

test("discovery accepts only strict token limits and drops conflicting duplicates", () => {
  const records = modelMetadataFromPayload({ data: [
    { id: "good", max_input_tokens: 272000, max_output_tokens: 128000 },
    { id: "bad", max_input_tokens: "1000", max_output_tokens: -1 },
    { id: "conflict", max_input_tokens: 256000, max_output_tokens: 64000 },
    { id: "conflict", max_input_tokens: 512000, max_output_tokens: 64000 },
  ] });
  assert.deepEqual(records, [
    { id: "bad" },
    { id: "conflict", maxOutputTokens: 64000 },
    { id: "good", maxInputTokens: 272000, maxOutputTokens: 128000 },
  ]);
});

test("model discovery rejects an oversized response before parsing it", async () => {
  const response = new Response("{}", {
    headers: { "content-length": String(9 * 1024 * 1024) },
  });
  await assert.rejects(boundedModelListJson(response), /too large/);
});

test("same-source metadata is additive while an endpoint change invalidates stale values", () => {
  const sourceA = providerSourceHash("https://gateway.example/v1");
  const sourceB = providerSourceHash("https://other.example/v1");
  let state = { version: 1, providers: [] };
  state = mergeLiveProviderMetadata(state, {
    id: "fixture", sourceHash: sourceA,
    models: [{ id: "a", maxInputTokens: 272000 }, { id: "b", maxInputTokens: 256000 }],
  }).payload;
  state = mergeLiveProviderMetadata(state, {
    id: "fixture", sourceHash: sourceA, models: [{ id: "a", maxOutputTokens: 128000 }],
  }).payload;
  assert.deepEqual(state.providers[0].models, [
    { id: "a", maxInputTokens: 272000, maxOutputTokens: 128000 },
    { id: "b", maxInputTokens: 256000 },
  ]);
  state = mergeLiveProviderMetadata(state, {
    id: "fixture", sourceHash: sourceB, models: [{ id: "c", maxInputTokens: 1000000 }],
  }).payload;
  assert.deepEqual(state.providers[0].models, [{ id: "c", maxInputTokens: 1000000 }]);
});

test("live limits override checked-in, manual, and auto-curated model sizing", () => {
  const providers = new Map([["fixture", { id: "fixture", importLiveModelMetadata: true }]]);
  const sourceHash = providerSourceHash("https://gateway.example/v1");
  const models = ["checked", "manual", "auto"].map((id) => ({
    slug: `fixture/${id}`,
    gatewayModel: `fixture-${id}`,
    upstreamModel: id,
    provider: "fixture",
    contextWindow: id === "manual" ? 999999 : 131072,
    autoCompact: 110000,
    compHash: `${id}-v1`,
    ...(id === "auto" ? { autoCurated: true } : {}),
  }));
  const effective = applyLiveModelMetadata(models, providers, {
    version: 1,
    providers: [{
      id: "fixture",
      sourceHash,
      models: [
        { id: "checked", maxInputTokens: 272000, maxOutputTokens: 128000 },
        { id: "manual", maxInputTokens: 512000, maxOutputTokens: 64000 },
        { id: "auto", maxInputTokens: 1000000, maxOutputTokens: 32000 },
      ],
    }],
  }, new Map([["fixture", sourceHash]]));
  assert.deepEqual(effective.map(({ contextWindow, autoCompact, maxOutputTokens }) => ({
    contextWindow, autoCompact, maxOutputTokens,
  })), [
    { contextWindow: 272000, autoCompact: 231200, maxOutputTokens: 128000 },
    { contextWindow: 512000, autoCompact: 435200, maxOutputTokens: 64000 },
    { contextWindow: 1000000, autoCompact: 850000, maxOutputTokens: 32000 },
  ]);
  assert.ok(effective.every((model, index) => model.compHash !== models[index].compHash));
});

test("metadata cache is atomic, private, and tolerant of malformed state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-live-metadata-"));
  const target = path.join(directory, "live.json");
  const sourceHash = providerSourceHash("https://gateway.example/v1");
  writeLiveModelMetadata({
    version: 1,
    providers: [{ id: "fixture", sourceHash, models: [{ id: "a", maxInputTokens: 272000 }] }],
  }, target);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(readLiveModelMetadata(target).providers[0].models[0].maxInputTokens, 272000);
  writeFileSync(target, "not-json");
  assert.deepEqual(readLiveModelMetadata(target), { version: 1, providers: [] });
});

test("fresh model-registry process overlays all user model origins", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-live-registry-"));
  const stateDir = path.join(directory, "state");
  const registryPath = path.join(directory, "registry.json");
  const provider = {
    id: "fixture", displayName: "Fixture", kind: "openai-compatible", ownedBy: "fixture",
    baseUrl: "https://gateway.example/v1", baseUrlEnv: "FIXTURE_BASE_URL",
    importLiveModelMetadata: true,
    credential: { environment: ["FIXTURE_KEY"], file: "fixture.secret", legacyFiles: [], keychainServices: [] },
  };
  const model = (id, priority) => ({
    slug: `fixture/${id}`, gatewayModel: `fixture-${id}`, upstreamModel: id, provider: "fixture",
    listed: true, displayName: id, description: id, priority, defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "High" }], contextWindow: 131072,
    autoCompact: 110000, inputModalities: ["text"], compHash: `${id}-v1`,
  });
  writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [provider], models: [model("checked", 1)] }));
  writeFileSync(path.join(directory, "user.json"), JSON.stringify({
    version: 1,
    models: [{ ...model("manual", 2) }, { ...model("auto", 3), autoCurated: true }],
  }));
  const sourceHash = providerSourceHash(provider.baseUrl);
  writeLiveModelMetadata({
    version: 1,
    providers: [{ id: "fixture", sourceHash, models: [
      { id: "checked", maxInputTokens: 272000, maxOutputTokens: 128000 },
      { id: "manual", maxInputTokens: 512000, maxOutputTokens: 64000 },
      { id: "auto", maxInputTokens: 1000000, maxOutputTokens: 32000 },
    ] }],
  }, path.join(stateDir, "live-model-metadata.json"));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
    'import { MODELS } from "./src/model-registry.mjs";',
    "process.stdout.write(JSON.stringify(MODELS.map(({upstreamModel,contextWindow,maxOutputTokens})=>({upstreamModel,contextWindow,maxOutputTokens}))));",
  ].join("\n")], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_ROUTER_REGISTRY: registryPath,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: path.join(directory, "user.json"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { upstreamModel: "checked", contextWindow: 272000, maxOutputTokens: 128000 },
    { upstreamModel: "manual", contextWindow: 512000, maxOutputTokens: 64000 },
    { upstreamModel: "auto", contextWindow: 1000000, maxOutputTokens: 32000 },
  ]);
  const yamlResult = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { renderLiteLlmConfig } from "./src/litellm-config.mjs"; process.stdout.write(renderLiteLlmConfig());',
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_ROUTER_REGISTRY: registryPath,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: path.join(directory, "user.json"),
    },
  });
  assert.equal(yamlResult.status, 0, yamlResult.stderr);
  assert.match(yamlResult.stdout, /max_input_tokens: 272000/);
  assert.match(yamlResult.stdout, /max_output_tokens: 128000/);
  assert.match(yamlResult.stdout, /max_input_tokens: 512000/);
  assert.match(yamlResult.stdout, /max_input_tokens: 1000000/);
  assert.match(readFileSync(path.join(stateDir, "live-model-metadata.json"), "utf8"), /272000/);
});
