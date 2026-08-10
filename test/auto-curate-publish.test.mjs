import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runModule(source, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("a fresh process publishes an auto-curated overlay to routes and picker catalog", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "auto-curate-publish-"));
  const stateDir = path.join(rootDir, "state");
  const codexHome = path.join(rootDir, "codex-home");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const registryPath = path.join(rootDir, "providers.json");
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    providers: [{
      id: "example-litellm",
      displayName: "Fixture Gateway",
      ownedBy: "test",
      kind: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      autoCurateDiscoveredModels: true,
      defaultApiSurface: "chat-completions",
      apiSurfaceOverrides: [{ prefix: "codex-gpt-", apiSurface: "responses" }],
      credential: {
        environment: ["EXAMPLE_LITELLM_API_KEY"],
        file: "example-litellm-api-key.secret",
      },
    }],
  }));
  const env = {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_REGISTRY: registryPath,
    CODEX_HOME: codexHome,
    // Node exits with a numeric status for `login status`; catalog.mjs treats
    // that as a real signed-out result while still having an executable probe.
    CODEX_BIN: process.execPath,
  };
  // An unrecognised upstream id uses the trusted gateway's conservative
  // default and remains visible in the picker.
  const upstream = "unknown-live-added-process-boundary";
  const slug = `example-litellm/${upstream}`;
  const gateway = `example-litellm-${upstream}`;

  try {
    writeFileSync(
      path.join(stateDir, "native-models.json"),
      `${JSON.stringify({
        models: [
          {
            slug: "gpt-test",
            display_name: "GPT Test",
            visibility: "list",
            priority: 10,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["example-litellm"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "example-litellm-api-key.secret"),
      "restricted-test-key-never-sent\n",
      { mode: 0o600 },
    );

    // Process A represents discovery committing the durable marker and the
    // additive overlay under one transaction.
    runModule(
      `import { autoCurateDiscoveredModels } from "./src/auto-curate-models.mjs";` +
        `const provider={id:"example-litellm",displayName:"Fixture Gateway",kind:"openai-compatible",autoCurateDiscoveredModels:true,defaultApiSurface:"chat-completions",apiSurfaceOverrides:[{prefix:"codex-gpt-",apiSurface:"responses"}]};` +
        `await autoCurateDiscoveredModels({providers:new Map([[provider.id,provider]]),registryModels:[],configured:()=>[provider.id],selected:()=>[provider.id],discover:async()=>({discovered:[${JSON.stringify(upstream)}],unavailable:[]})});`,
      env,
    );
    assert.equal(existsSync(path.join(stateDir, "auto-curate-refresh.pending")), true);

    // Process B must import the registry after A exits; this is the ESM-cache
    // boundary the startup preflight relies on.
    runModule('import { writeLiteLlmConfig } from "./src/litellm-config.mjs";writeLiteLlmConfig();', env);
    assert.match(readFileSync(path.join(stateDir, "litellm.yaml"), "utf8"), new RegExp(gateway));

    const catalog = spawnSync(process.execPath, [path.join(root, "src", "catalog.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(catalog.status, 0, catalog.stderr);
    const merged = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    const published = merged.models.find((model) => model.slug === slug);
    assert.ok(published, `missing ${slug}`);
    assert.equal(published.apply_patch_tool_type, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
