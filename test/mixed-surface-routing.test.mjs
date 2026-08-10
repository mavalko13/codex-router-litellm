import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = mkdtempSync(path.join(os.tmpdir(), "mixed-surface-"));
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.CODEX_ROUTER_LITELLM_API_KEY = "test-virtual-key";
process.env.CODEX_ROUTER_LITELLM_BASE_URL = "";

const { planAutoCuratedModels } = await import("../src/auto-curate-models.mjs");
const { effectiveApiSurface } = await import("../src/api-surface.mjs");
const { userModelEntry } = await import("../src/user-models.mjs");
const { openPort } = await import("./port-pool.mjs");

const provider = {
  id: "example-litellm",
  displayName: "Example LiteLLM",
  kind: "openai-compatible",
  autoCurateDiscoveredModels: true,
  defaultApiSurface: "chat-completions",
  apiSurfaceOverrides: [{ prefix: "codex-gpt-", apiSurface: "responses" }],
};

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("codex-gpt-* models get apiSurface responses and are listed", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: ["codex-gpt-5.5", "codex-gpt-5.6-sol", "codex-gpt-5.6-terra"],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 3);
  for (const model of result.additions) {
    assert.equal(model.apiSurface, "responses", `${model.upstreamModel} should be responses`);
    assert.equal(model.listed, true, `${model.upstreamModel} should be listed`);
    assert.equal(model.supportsApplyPatchTool, false);
  }
});

test("ollama-cloud-* models get apiSurface chat-completions and are listed", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: ["ollama-cloud-deepseek-v4-flash", "ollama-cloud-glm-5-2"],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 2);
  for (const model of result.additions) {
    assert.equal(model.apiSurface, "chat-completions");
    assert.equal(model.listed, true);
  }
});

test("deepseek-* glm-* kimi-* minimax-* qwen* mimo-* models get chat-completions", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: ["deepseek-v4-flash", "glm-5.2", "kimi-k2.7-code", "minimax-m3", "qwen3.8-max", "mimo-v2.5"],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 6);
  for (const model of result.additions) {
    assert.equal(model.apiSurface, "chat-completions");
    assert.equal(model.listed, true);
  }
});

test("model-name inference is scoped to the trusted example provider provider", () => {
  const foreign = {
    id: "another-openai-provider",
    displayName: "Another provider",
    kind: "openai-compatible",
  };
  assert.equal(
    effectiveApiSurface({ upstreamModel: "codex-gpt-5.6-sol", autoCurated: true }, foreign),
    "chat-completions",
  );
  assert.equal(
    effectiveApiSurface({ upstreamModel: "anything", protocol: "ignored" }, {
      ...foreign,
      protocol: "openai-responses",
    }),
    "responses",
  );
});

test("provider-scoped literal prefixes override the conservative default", () => {
  assert.equal(
    effectiveApiSurface({ upstreamModel: "codex-gpt-manually-curated" }, provider),
    "responses",
  );
  assert.equal(
    effectiveApiSurface({ upstreamModel: "glm-manually-curated" }, provider),
    "chat-completions",
  );
  assert.equal(
    effectiveApiSurface({ upstreamModel: "unknown-manually-curated" }, provider),
    "chat-completions",
  );
  assert.equal(
    effectiveApiSurface({
      upstreamModel: "codex-gpt-manually-curated",
      apiSurface: "responses",
    }, provider),
    "responses",
  );
});

test("override matching is literal and longest-prefix wins", () => {
  const configured = {
    ...provider,
    apiSurfaceOverrides: [
      { prefix: "codex-", apiSurface: "chat-completions" },
      { prefix: "codex-gpt-", apiSurface: "responses" },
      { prefix: "^regex-looking", apiSurface: "responses" },
    ],
  };
  assert.equal(effectiveApiSurface({ upstreamModel: "codex-gpt-model" }, configured), "responses");
  assert.equal(effectiveApiSurface({ upstreamModel: "regex-looking-model" }, configured), "chat-completions");
});

test("unknown ids remain listed with the provider default surface", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: ["totally-unknown-model", "mystery-vendor-special"],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 2);
  for (const model of result.additions) {
    assert.equal(model.apiSurface, "chat-completions");
    assert.equal(model.listed, true);
  }
});

test("registry siblings with apiSurface are inherited for matching upstream ids", () => {
  const registrySibling = {
    ...userModelEntry({
      providerId: provider.id,
      upstreamId: "ollama-cloud-deepseek-v4-flash",
      apiSurface: "chat-completions",
      priority: 10,
    }),
  };
  const result = planAutoCuratedModels({
    provider,
    discovered: ["ollama-cloud-deepseek-v4-flash", "codex-gpt-5.5"],
    registryModels: [registrySibling],
    userModels: [],
  });
  assert.equal(result.additions.length, 1);
  assert.equal(result.additions[0].upstreamModel, "codex-gpt-5.5");
  assert.equal(result.additions[0].apiSurface, "responses");
  assert.equal(result.additions[0].listed, true);
  assert.deepEqual(result.skipped, ["ollama-cloud-deepseek-v4-flash"]);
});

test("mixed discovery produces both surfaces in one pass", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: [
      "ollama-cloud-deepseek-v4-flash",
      "ollama-cloud-glm-5-2",
      "codex-gpt-5.5",
      "codex-gpt-5.6-sol",
      "totally-unknown-model",
    ],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 5);

  const responses = result.additions.filter((m) => m.apiSurface === "responses");
  const chat = result.additions.filter((m) => m.apiSurface === "chat-completions");
  const unknown = result.additions.filter((m) => m.upstreamModel === "totally-unknown-model");
  assert.equal(responses.length, 2);
  assert.equal(chat.length, 3);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].upstreamModel, "totally-unknown-model");
  assert.equal(unknown[0].apiSurface, "chat-completions");
  assert.equal(unknown[0].listed, true);

  for (const model of [...responses, ...chat]) {
    assert.equal(model.listed, true);
  }
});

test("apiSurface is validated by the registry loader", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reg-surface-"));
  writeFileSync(
    path.join(dir, "provider.json"),
    JSON.stringify({
      version: 1,
      providers: [{
        id: "test-surface",
        displayName: "Test Surface",
        kind: "openai-compatible",
        ownedBy: "test",
        baseUrl: "https://example.com/v1",
        credential: { environment: ["TEST_KEY"], file: "test-key.secret" },
      }],
    }),
  );
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      version: 1,
      models: [{
        slug: "test-surface/model-a",
        gatewayModel: "test-surface-model-a",
        upstreamModel: "model-a",
        provider: "test-surface",
        listed: true,
        apiSurface: "invalid-surface",
        displayName: "Model A",
        description: "Test",
        priority: 1,
        defaultEffort: "high",
        reasoningLevels: [{ effort: "high", description: "Adaptive" }],
        contextWindow: 131072,
        autoCompact: 110000,
        inputModalities: ["text"],
        compHash: "test-surface-model-a-v1",
      }],
    }),
  );
  try {
    const result = spawnSync(process.execPath, [
      "-e",
      "import('./src/model-registry.mjs').catch(e=>{console.error(e.message);process.exit(1);})",
    ], { cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: dir } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported apiSurface/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider API-surface defaults and overrides are validated", () => {
  const cases = [
    [{ importLiveModelMetadata: "yes" }, /invalid importLiveModelMetadata flag/],
    [{ defaultApiSurface: "completions" }, /unsupported defaultApiSurface/],
    [{ apiSurfaceOverrides: {} }, /invalid apiSurfaceOverrides/],
    [{ apiSurfaceOverrides: [{ prefix: "", apiSurface: "responses" }] }, /invalid apiSurfaceOverride/],
    [{ apiSurfaceOverrides: [{ prefix: "model-", apiSurface: "completions" }] }, /invalid apiSurfaceOverride/],
    [{ apiSurfaceOverrides: [
      { prefix: "model-", apiSurface: "responses" },
      { prefix: "model-", apiSurface: "chat-completions" },
    ] }, /duplicate apiSurfaceOverride prefix/],
  ];
  for (const [fields, expected] of cases) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provider-surface-validation-"));
    try {
      writeFileSync(path.join(dir, "provider.json"), JSON.stringify({
        version: 1,
        providers: [{
          id: "example-litellm",
          displayName: "Example LiteLLM",
          ownedBy: "test",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credential: { environment: ["EXAMPLE_KEY"], file: "example.secret" },
          ...fields,
        }],
      }));
      const result = spawnSync(process.execPath, [
        "-e",
        "import('./src/model-registry.mjs').catch(e=>{console.error(e.message);process.exit(1);})",
      ], { cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: dir } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("litellm config renders mixed-surface routes correctly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mixed-reg-"));
  const state = mkdtempSync(path.join(os.tmpdir(), "mixed-state-"));
  writeFileSync(
    path.join(dir, "provider.json"),
    JSON.stringify({
      version: 1,
      providers: [{
        id: "mixed-dev",
        displayName: "Mixed DEV",
        kind: "openai-compatible",
        ownedBy: "test",
        baseUrl: "https://example.com/v1",
        baseUrlEnv: "MIXED_DEV_BASE_URL",
        autoCurateDiscoveredModels: true,
        credential: { environment: ["MIXED_DEV_KEY"], file: "mixed-dev-key.secret" },
      }],
      models: [
        {
          slug: "mixed-dev/ollama-model",
          gatewayModel: "mixed-dev-ollama-model",
          upstreamModel: "ollama-cloud-model",
          provider: "mixed-dev",
          listed: true,
          apiSurface: "chat-completions",
          displayName: "Ollama Model",
          description: "Chat completions model",
          priority: 10,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text"],
          compHash: "mixed-dev-ollama-model-v1",
        },
        {
          slug: "mixed-dev/codex-model",
          gatewayModel: "mixed-dev-codex-model",
          upstreamModel: "codex-gpt-model",
          provider: "mixed-dev",
          listed: true,
          apiSurface: "responses",
          displayName: "Codex Model",
          description: "Responses model",
          priority: 11,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text"],
          compHash: "mixed-dev-codex-model-v1",
        },
      ],
    }),
  );
  writeFileSync(
    path.join(state, "user-models.json"),
    JSON.stringify({ version: 1, models: [] }),
  );

  const env = {
    ...process.env,
    MODEL_ROUTER_REGISTRY: dir,
    MODEL_ROUTER_STATE_DIR: state,
  };

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { renderLiteLlmConfig } from "./src/litellm-config.mjs";
      process.stdout.write(renderLiteLlmConfig());
    `], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    const yaml = result.stdout;

    // The ollama model should use chat completions (use_chat_completions_api: true)
    const ollamaBlock = yaml.slice(
      yaml.indexOf('model_name: "mixed-dev-ollama-model"'),
      yaml.indexOf("model_name:", yaml.indexOf('model_name: "mixed-dev-ollama-model"') + 1),
    );
    assert.match(ollamaBlock, /use_chat_completions_api: true/);
    assert.doesNotMatch(ollamaBlock, /responses\//);

    // The codex model should use the Responses API (no use_chat_completions_api)
    const codexBlock = yaml.slice(
      yaml.indexOf('model_name: "mixed-dev-codex-model"'),
      yaml.indexOf("model_name:", yaml.indexOf('model_name: "mixed-dev-codex-model"') + 1),
    );
    assert.match(codexBlock, /responses\//);
    assert.doesNotMatch(codexBlock, /use_chat_completions_api/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("manual user models preserve their apiSurface through userModelEntry", () => {
  const entry = userModelEntry({
    providerId: "example-litellm",
    upstreamId: "codex-gpt-5.5",
    apiSurface: "responses",
    priority: 100,
    metadata: { displayName: "Manual Codex GPT 5.5" },
  });
  assert.equal(entry.apiSurface, "responses");
  assert.equal(entry.slug, "example-litellm/codex-gpt-5.5");
  assert.equal(entry.listed, true);

  const chatEntry = userModelEntry({
    providerId: "example-litellm",
    upstreamId: "ollama-cloud-glm-5-2",
    apiSurface: "chat-completions",
    priority: 101,
  });
  assert.equal(chatEntry.apiSurface, "chat-completions");
  assert.equal(chatEntry.listed, true);

  // Without apiSurface the entry defaults to listed (backward compat)
  const legacyEntry = userModelEntry({
    providerId: "example-litellm",
    upstreamId: "ollama-cloud-deepseek-v4-flash",
    priority: 102,
  });
  assert.equal(legacyEntry.apiSurface, undefined);
  assert.equal(legacyEntry.listed, true);
});

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function waitForForwarder(port, child, errors) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer mixed-surface-internal-key" },
      });
      if (response.ok) return;
    } catch {
      // It has not bound the test port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`forwarder did not become ready: ${errors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function runNodeModule(source, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.once("exit", resolve));
  return { status, stdout, stderr };
}

test("fixture drives discovery through fresh registry, LiteLLM, and both forwarder surfaces", async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "mixed-surface-e2e-"));
  const state = path.join(work, "state");
  const codexHome = path.join(work, "codex-home");
  const registry = path.join(work, "registry.json");
  const fixture = JSON.parse(
    readFileSync(path.join(root, "test", "fixtures", "example-litellm-mixed-models.json"), "utf8"),
  );
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      seen.push({ url: request.url });
      json(response, 200, fixture);
      return;
    }
    seen.push({ url: request.url, body: await requestBody(request) });
    json(response, 200, { id: "fixture-response", output: [], choices: [] });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(typeof upstreamAddress === "object" && upstreamAddress);
  const providerBase = `http://127.0.0.1:${upstreamAddress.port}/v1`;
  mkdirSync(state, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(state, "example-litellm-api-key.secret"),
    "fixture-provider-key\n",
    { mode: 0o600 },
  );
  writeFileSync(registry, JSON.stringify({
    version: 1,
    providers: [{
      ...provider,
      ownedBy: "test",
      baseUrl: providerBase,
      baseUrlEnv: "EXAMPLE_LITELLM_BASE_URL",
      credential: {
        environment: ["EXAMPLE_LITELLM_API_KEY"],
        file: "example-litellm-api-key.secret",
      },
    }],
    models: [],
  }));
  const env = {
    ...process.env,
    MODEL_ROUTER_REGISTRY: registry,
    MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_HOME: codexHome,
    CODEX_BIN: process.execPath,
    EXAMPLE_LITELLM_BASE_URL: providerBase,
    EXAMPLE_LITELLM_API_KEY: "fixture-provider-key",
  };

  let forwarder;
  try {
    const discovery = await runNodeModule(`
      import { autoCurateDiscoveredModels } from "./src/auto-curate-models.mjs";
      await autoCurateDiscoveredModels({
        configured: () => ["example-litellm"],
        selected: () => ["example-litellm"],
      });
    `, env);
    assert.equal(discovery.status, 0, discovery.stderr);

    const legacyPath = path.join(state, "user-models.json");
    const overlay = JSON.parse(readFileSync(legacyPath, "utf8"));
    const legacy = overlay.models.find((model) => model.upstreamModel === "codex-gpt-5.5");
    delete legacy.apiSurface;
    delete legacy.autoCurated;
    legacy.displayName = "Operator preserved name";
    legacy.contextWindow = 424242;
    writeFileSync(legacyPath, `${JSON.stringify(overlay, null, 2)}\n`);

    const migration = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { autoCurateDiscoveredModels } from "./src/auto-curate-models.mjs";
      const provider = {
        id: "example-litellm",
        displayName: "Example LiteLLM",
        kind: "openai-compatible",
        autoCurateDiscoveredModels: true,
        defaultApiSurface: "chat-completions",
        apiSurfaceOverrides: [{ prefix: "codex-gpt-", apiSurface: "responses" }],
      };
      await autoCurateDiscoveredModels({
        providers: new Map([[provider.id, provider]]),
        registryModels: [],
        configured: () => [provider.id],
        selected: () => [provider.id],
        discover: async () => ({ discovered: [], unavailable: [] }),
      });
    `], { cwd: root, env, encoding: "utf8" });
    assert.equal(migration.status, 0, migration.stderr);
    const migrated = JSON.parse(readFileSync(legacyPath, "utf8")).models.find(
      (model) => model.upstreamModel === "codex-gpt-5.5",
    );
    assert.equal(migrated.apiSurface, "responses");
    assert.equal(migrated.displayName, "Operator preserved name");
    assert.equal(migrated.contextWindow, 424242);

    const fresh = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { MODELS, API_MODELS, LISTED_MODELS } from "./src/model-registry.mjs";
      import { renderLiteLlmConfig } from "./src/litellm-config.mjs";
      process.stdout.write(JSON.stringify({
        models: MODELS.map((model) => model.upstreamModel),
        apiModels: API_MODELS.map((model) => model.upstreamModel),
        listed: LISTED_MODELS.map((model) => model.upstreamModel),
        yaml: renderLiteLlmConfig(),
      }));
    `], { cwd: root, env, encoding: "utf8" });
    assert.equal(fresh.status, 0, fresh.stderr);
    const published = JSON.parse(fresh.stdout);
    for (const field of ["models", "apiModels", "listed"]) {
      assert.ok(published[field].includes("codex-gpt-5.6-sol"));
      assert.ok(published[field].includes("ollama-cloud-deepseek-v4-flash"));
      assert.ok(published[field].includes("totally-unknown-model"));
    }
    assert.match(published.yaml, /openai\/responses\/example-litellm-codex-gpt-5-6-sol/);
    assert.match(published.yaml, /model_name: "example-litellm-ollama-cloud-deepseek-v4-flash"/);
    assert.match(published.yaml, /totally-unknown-model/);

    writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({
      version: 1,
      providers: ["example-litellm"],
    }));
    writeFileSync(path.join(state, "native-models.json"), JSON.stringify({
      models: [{
        slug: "gpt-fixture-native",
        display_name: "Fixture Native",
        visibility: "list",
        priority: 1,
      }],
    }));
    const catalog = spawnSync(process.execPath, [path.join(root, "src", "catalog.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(catalog.status, 0, catalog.stderr);
    const pickerSlugs = JSON.parse(
      readFileSync(path.join(state, "merged-models.json"), "utf8"),
    ).models.map((model) => model.slug);
    assert.ok(pickerSlugs.includes("example-litellm/codex-gpt-5.6-sol"));
    assert.ok(pickerSlugs.includes("example-litellm/totally-unknown-model"));

    const forwarderPort = await openPort();
    const forwarderEnv = {
      ...env,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_INTERNAL_KEY: "mixed-surface-internal-key",
      MODEL_ROUTER_QUIET: "1",
    };
    let errors = "";
    forwarder = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
      cwd: root,
      env: forwarderEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    forwarder.stderr.setEncoding("utf8");
    forwarder.stderr.on("data", (chunk) => { errors += chunk; });
    await waitForForwarder(forwarderPort, forwarder, () => errors);
    const headers = {
      Authorization: "Bearer mixed-surface-internal-key",
      "Content-Type": "application/json",
    };
    const modelsResponse = await fetch(`http://127.0.0.1:${forwarderPort}/v1/models`, { headers });
    assert.equal(modelsResponse.status, 200);
    const ids = (await modelsResponse.json()).data.map((model) => model.id);
    assert.ok(ids.includes("example-litellm-codex-gpt-5-6-sol"));
    assert.ok(ids.includes("example-litellm-ollama-cloud-deepseek-v4-flash"));
    assert.ok(ids.includes("example-litellm-totally-unknown-model"));

    const chat = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "example-litellm-ollama-cloud-deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
      }),
    });
    assert.equal(chat.status, 200, await chat.text());
    const responses = await fetch(`http://127.0.0.1:${forwarderPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "example-litellm-codex-gpt-5-6-sol",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
      }),
    });
    assert.equal(responses.status, 200, await responses.text());

    assert.ok(seen.some((entry) => entry.url === "/v1/models"));
    assert.deepEqual(seen.filter((entry) => entry.body).map((entry) => entry.url), [
      "/v1/chat/completions",
      "/v1/responses",
    ]);
    const routed = seen.filter((entry) => entry.body);
    assert.equal(routed[0].body.model, "ollama-cloud-deepseek-v4-flash");
    assert.equal(routed[0].body.messages[0].content[0].type, "text");
    assert.equal(routed[1].body.model, "codex-gpt-5.6-sol");
    assert.equal(routed[1].body.input[0].content[0].type, "input_text");
    assert.doesNotMatch(errors, /fixture-provider-key/);
  } finally {
    if (forwarder) await stopChild(forwarder);
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
});
