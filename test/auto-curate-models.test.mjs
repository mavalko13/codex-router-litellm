import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MODEL_ROUTER_USER_MODELS = path.join(
  mkdtempSync(path.join(os.tmpdir(), "auto-curate-test-")),
  "user-models.json",
);

const { autoCurateDiscoveredModels, planAutoCuratedModels } = await import(
  "../src/auto-curate-models.mjs"
);
const { userModelEntry } = await import("../src/user-models.mjs");
const { periodicAutoCurateAction } = await import("../src/auto-curate-state.mjs");

const provider = {
  id: "trusted-dev",
  displayName: "Trusted DEV",
  kind: "openai-compatible",
  autoCurateDiscoveredModels: true,
};
const providers = new Map([[provider.id, provider]]);
const builtIn = userModelEntry({
  providerId: provider.id,
  upstreamId: "registered-model",
  priority: 10,
});
const manual = userModelEntry({
  providerId: provider.id,
  upstreamId: "manual-model",
  priority: 140,
  metadata: { displayName: "Operator name", contextWindow: 262144 },
});

function dependencies(overrides = {}) {
  const writes = [];
  const logs = [];
  const options = {
    providers,
    registryModels: [builtIn],
    configured: () => [provider.id],
    selected: () => [provider.id],
    read: () => ({ exists: true, valid: true, models: [manual] }),
    log: (message) => logs.push(message),
    markPending: () => {},
    assertOwner: () => {},
    discover: async () => ({
      discovered: ["registered-model", "manual-model", "new-model"],
      unavailable: [],
    }),
    ...overrides,
  };
  if (!options.update) {
    options.update = (operation) => {
      const result = operation(options.read());
      if (Array.isArray(result?.models)) writes.push(result.models);
      return result?.value;
    };
  }
  return {
    writes,
    logs,
    options,
  };
}

test("auto-curation appends only new live ids with conservative metadata", async () => {
  const state = dependencies();
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 1);
  assert.equal(state.writes.length, 1);
  const [preserved, added] = state.writes[0];
  assert.deepEqual(preserved, manual);
  assert.equal(added.slug, "trusted-dev/new-model");
  assert.equal(added.displayName, "new-model (auto-curated)");
  assert.match(added.description, /Auto-curated from the live Trusted DEV model catalog/);
  assert.equal(added.contextWindow, 131072);
  assert.equal(added.autoCompact, 110000);
  assert.equal(added.defaultEffort, "high");
  assert.deepEqual(added.reasoningLevels, [
    { effort: "high", description: "Adaptive reasoning" },
  ]);
  assert.deepEqual(added.inputModalities, ["text"]);
  assert.equal(added.supportsApplyPatchTool, false);
  assert.equal(added.multiAgentVersion, undefined);
  assert.equal(added.searchTool, undefined);
  assert.ok(state.logs.some((line) => /auto-curated 1 models for provider trusted-dev/.test(line)));
  assert.ok(state.logs.some((line) => /"manual-model", "registered-model"/.test(line)));
});

test("untrusted model ids are escaped before they reach logs", async () => {
  const state = dependencies({
    discover: async () => ({
      discovered: ["registered-model", "line-break\nforged-log"],
      unavailable: [],
    }),
  });
  await autoCurateDiscoveredModels(state.options);
  const combined = state.logs.join("\n");
  assert.match(combined, /"line-break\\nforged-log"/);
  assert.doesNotMatch(combined, /line-break\nforged-log/);
});

test("auto-curation is opt-in, selected, and credential-gated", async () => {
  for (const override of [
    { providers: new Map([[provider.id, { ...provider, autoCurateDiscoveredModels: false }]]) },
    { selected: () => [] },
    { configured: () => [] },
  ]) {
    let discoveries = 0;
    const state = dependencies({
      ...override,
      discover: async () => {
        discoveries += 1;
        return { discovered: ["new-model"], unavailable: [] };
      },
    });
    const result = await autoCurateDiscoveredModels(state.options);
    assert.equal(result.added, 0);
    assert.equal(discoveries, 0);
    assert.equal(state.writes.length, 0);
  }
});

test("discovery failures are non-fatal and never echo provider error bodies", async () => {
  const state = dependencies({
    discover: async () => {
      throw new Error("upstream echoed secret sk-live-do-not-log");
    },
  });
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(result.failures[0].reason, "discovery-failed");
  assert.ok(state.logs.some((line) => /keeping the existing catalog/.test(line)));
  assert.ok(state.logs.every((line) => !line.includes("sk-live-do-not-log")));
});

test("missing live ids are logged and preserved rather than pruned", async () => {
  const state = dependencies({
    discover: async () => ({
      discovered: ["registered-model", "manual-model"],
      unavailable: ["temporarily-missing"],
    }),
  });
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 0);
  assert.equal(state.writes.length, 0);
  assert.ok(state.logs.some((line) => /locally preserved ids: "temporarily-missing"/.test(line)));
});

test("an unreadable overlay is never replaced", async () => {
  const state = dependencies({
    read: () => ({ exists: true, valid: false, models: [] }),
  });
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(result.failures[0].reason, "user-models-invalid");
});

test("gateway-id collisions are skipped conservatively", () => {
  const result = planAutoCuratedModels({
    provider,
    discovered: ["family/model", "family-model"],
    registryModels: [],
    userModels: [],
  });
  assert.equal(result.additions.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.additions[0].gatewayModel, "trusted-dev-family-model");
});

test("a concurrent valid manual edit is retained before the atomic write", async () => {
  const laterManual = userModelEntry({
    providerId: provider.id,
    upstreamId: "manual-added-during-discovery",
    priority: 150,
  });
  let reads = 0;
  const state = dependencies({
    read: () => ({
      exists: true,
      valid: true,
      models: reads++ === 0 ? [manual] : [manual, laterManual],
    }),
    discover: async () => ({ discovered: ["new-model"], unavailable: [] }),
  });
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 1);
  assert.deepEqual(
    state.writes[0].map((model) => model.upstreamModel),
    ["manual-model", "manual-added-during-discovery", "new-model"],
  );
});

test("the durable pending marker is written before the overlay commit", async () => {
  const events = [];
  const state = dependencies({
    markPending: () => events.push("marker"),
    update: (operation) => {
      const result = operation({ exists: true, valid: true, models: [manual] });
      if (Array.isArray(result.models)) events.push("overlay");
      return result.value;
    },
  });
  const result = await autoCurateDiscoveredModels(state.options);
  assert.equal(result.added, 1);
  assert.deepEqual(events, ["marker", "overlay"]);
});

test("a marker failure prevents the overlay from being committed", async () => {
  let committed = false;
  const state = dependencies({
    markPending: () => {
      throw new Error("marker unavailable");
    },
    update: (operation) => {
      const result = operation({ exists: true, valid: true, models: [manual] });
      if (Array.isArray(result?.models)) committed = true;
      return result?.value;
    },
  });
  await assert.rejects(autoCurateDiscoveredModels(state.options), /marker unavailable/);
  assert.equal(committed, false);
});

test("auto-curation asserts state ownership before its first managed write", async () => {
  let writes = 0;
  const state = dependencies({
    assertOwner: (operation) => {
      assert.equal(operation, "write auto-curated model state");
      const error = new Error("foreign checkout");
      error.code = "foreign_state_owner";
      throw error;
    },
    update: () => {
      writes += 1;
    },
  });
  await assert.rejects(autoCurateDiscoveredModels(state.options), {
    code: "foreign_state_owner",
  });
  assert.equal(writes, 0);
});

test("pending publication restarts even when discovery added nothing", () => {
  assert.equal(periodicAutoCurateAction({ summary: { added: 0 }, pending: true }), "restart");
  assert.equal(periodicAutoCurateAction({ summary: { added: 0 }, pending: false }), "idle");
  assert.equal(periodicAutoCurateAction({ summary: undefined, pending: false }), "failed");
});
