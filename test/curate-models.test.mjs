import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// curate-models.mjs validates process.argv at module scope and exits when the
// provider is missing, so give it a real invocation before importing. This is
// the flow PR #76 tried to bypass by hardcoding models, and it had no test
// coverage of any kind.
const savedArgv = [...process.argv];
process.argv = [process.argv[0], "curate-models.mjs", "gemini-api"];
const { applyApiSurfaceUpdates, modelSelectionOption, parseApiSurface, parseEfforts, parseRequestProfile, planCuration, renderRows } = await import(
  "../src/curate-models.mjs"
);
const { trustedApiSurfaceForUpstream } = await import("../src/api-surface.mjs");
process.argv = savedArgv;
process.exitCode = 0;

const curated = (upstreamModel, metadata = {}) => ({
  upstreamModel,
  provider: "fireworks",
  ...metadata,
});

test("an additive model run keeps unrelated curated metadata", () => {
  const existing = curated("accounts/fireworks/models/kimi-k3", { contextWindow: 262144 });
  const result = planCuration({
    mine: [existing],
    chosen: ["accounts/fireworks/models/deepseek-v4-flash"],
    removals: [],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [existing]);
  assert.deepEqual(result.additions, ["accounts/fireworks/models/deepseek-v4-flash"]);
});

test("an additive model run is idempotent and deduplicates input", () => {
  const existing = curated("accounts/fireworks/models/kimi-k3");
  const result = planCuration({
    mine: [existing],
    chosen: [existing.upstreamModel, existing.upstreamModel],
    removals: [],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [existing]);
  assert.deepEqual(result.additions, []);
});

test("explicit removal prunes only the named curated model", () => {
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  const result = planCuration({
    mine: [kept, removed],
    chosen: [],
    removals: [removed.upstreamModel],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [kept]);
  assert.deepEqual(result.additions, []);
});

test("--remove edits local curation without provider credentials or discovery", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-models-remove-"));
  const file = path.join(dir, "user-models.json");
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  writeFileSync(file, JSON.stringify({ version: 1, models: [kept, removed] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "fireworks",
        "--remove",
        removed.upstreamModel,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FIREWORKS_API_KEY: "",
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_STATE_DIR: dir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored.models, [kept]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interactive deselection remains authoritative", () => {
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  const result = planCuration({
    mine: [kept, removed],
    chosen: [kept.upstreamModel, "accounts/fireworks/models/glm-5.2"],
    removals: [],
    interactive: true,
  });
  assert.deepEqual(result.surviving, [kept]);
  assert.deepEqual(result.additions, ["accounts/fireworks/models/glm-5.2"]);
});

test("efforts are returned in the documented order, not the order typed", () => {
  // The stored model advertises these to the picker, where an arbitrary order
  // would present "high, low, medium" to the user.
  const parsed = parseEfforts("high,low,medium");
  assert.deepEqual(
    parsed.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high"],
  );
  for (const level of parsed.reasoningLevels) {
    assert.ok(level.description, `${level.effort} needs a description`);
  }
});

test("high is preferred as the default when offered", () => {
  assert.equal(parseEfforts("low,high,minimal").defaultEffort, "high");
});

test("without high, the strongest offered effort becomes the default", () => {
  // Falling back to the weakest would quietly downgrade every request made
  // through a curated model.
  assert.equal(parseEfforts("minimal,low").defaultEffort, "low");
  assert.equal(parseEfforts("medium,xhigh").defaultEffort, "xhigh");
});

test("an unknown effort is rejected by name", () => {
  // A typo must not be silently dropped: the model would be stored advertising
  // fewer efforts than the user asked for.
  assert.throws(() => parseEfforts("high,turbo"), /Unknown reasoning effort "turbo"/);
});

test("whitespace and casing are tolerated", () => {
  const parsed = parseEfforts(" HIGH , low ");
  assert.deepEqual(
    parsed.reasoningLevels.map((level) => level.effort),
    ["low", "high"],
  );
});

test("an empty efforts list leaves the model defaults alone", () => {
  assert.equal(parseEfforts(""), undefined);
  assert.equal(parseEfforts(" , , "), undefined);
});

test("a curated model can opt into the auto tool-choice profile", () => {
  // A reseller-hosted model whose upstream rejects tool_choice "required" is
  // otherwise unreachable: the catalog-only providers ship no registry model
  // to inherit a profile from, so the first curated model gets none.
  assert.equal(parseRequestProfile("auto-tool-choice"), "auto-tool-choice");
});

test("an unknown request profile is rejected by name", () => {
  // Nothing validates requestProfile downstream — the forwarder just runs no
  // branch — so a typo would store a model that silently keeps failing.
  assert.throws(() => parseRequestProfile("qwen-plan"), /Unknown request profile "qwen-plan"/);
  assert.throws(() => parseRequestProfile("auto_tool_choice"), /Unknown request profile/);
});

test("an empty request profile leaves the model without one", () => {
  assert.equal(parseRequestProfile(""), undefined);
  assert.equal(parseRequestProfile("  "), undefined);
});

test("request profile whitespace and casing are tolerated", () => {
  assert.equal(parseRequestProfile(" Auto-Tool-Choice "), "auto-tool-choice");
});

test("manual curation validates explicit API surfaces", () => {
  assert.equal(parseApiSurface(" Responses "), "responses");
  assert.equal(parseApiSurface("CHAT-COMPLETIONS"), "chat-completions");
  assert.throws(() => parseApiSurface("completions"), /Unknown API surface/);
});

test("manual curation accepts a positional model id", () => {
  assert.equal(
    modelSelectionOption(["node", "curate-models.mjs", "example-litellm", "model-a", "--no-apply"]),
    "model-a",
  );
  assert.equal(
    modelSelectionOption(["node", "curate-models.mjs", "example-litellm", "--models", "model-b"]),
    "model-b",
  );
});

test("trusted mixed-provider aliases infer the correct API surface", () => {
  const provider = {
    id: "example-litellm",
    defaultApiSurface: "chat-completions",
    apiSurfaceOverrides: [
      { prefix: "codex-gpt-", apiSurface: "responses" },
      { prefix: "gpt-", apiSurface: "responses" },
      { prefix: "o4-", apiSurface: "responses" },
    ],
  };
  assert.equal(trustedApiSurfaceForUpstream(provider, "codex-gpt-5.6-sol"), "responses");
  assert.equal(trustedApiSurfaceForUpstream(provider, "gpt-5.6"), "responses");
  assert.equal(trustedApiSurfaceForUpstream(provider, "o4-mini"), "responses");
  assert.equal(trustedApiSurfaceForUpstream(provider, "ollama-cloud-qwen3"), "chat-completions");
  assert.equal(trustedApiSurfaceForUpstream(provider, "glm-5.2"), "chat-completions");
  assert.equal(trustedApiSurfaceForUpstream(provider, "unknown-model"), "chat-completions");
});

test("manual surface updates preserve auto-curated metadata", () => {
  const existing = curated("model-a", {
    autoCurated: true,
    apiSurface: "chat-completions",
    displayName: "Operator label",
    contextWindow: 262144,
  });
  const result = applyApiSurfaceUpdates([existing], ["model-a"], "responses");
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.updated, ["model-a"]);
  assert.deepEqual(result.models, [{ ...existing, apiSurface: "responses" }]);
});

test("manual surface updates reject ordinary hand-curated entries", () => {
  const existing = curated("model-a", { displayName: "Hand curated" });
  const result = applyApiSurfaceUpdates([existing], ["model-a"], "responses");
  assert.deepEqual(result.models, [existing]);
  assert.deepEqual(result.blocked, ["model-a"]);
});

test("manual curation persists its resolved API surface", () => {
  const source = readFileSync(path.join(root, "src", "curate-models.mjs"), "utf8");
  assert.match(source, /apiSurface:\s*apiSurfaceFor\(id\)/);
});

test("the picker marks selection and existing curation separately", () => {
  // Two independent facts share one row: whether this run will keep the model,
  // and whether it is already curated. Conflating them would make deselecting
  // an existing model look like a no-op.
  const rows = renderRows(
    ["gemini-3.5-flash", "gemini-3.5-pro"],
    new Set(["gemini-3.5-flash"]),
    new Set([2]),
  );
  const [first, second] = rows.split("\n");
  assert.match(first, /\[ \] 1\. gemini-3\.5-flash \(currently curated\)/);
  assert.match(second, /\[x\] 2\. gemini-3\.5-pro \(new\)/);
});
