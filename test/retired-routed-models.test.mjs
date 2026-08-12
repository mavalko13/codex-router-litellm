import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "retired-routed-models-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  readRetiredRoutedModels,
  reconcileRetiredRoutedModels,
  recordRetiredRoutedModels,
} = await import("../src/retired-routed-models.mjs");
const { RETIRED_ROUTED_MODELS_PATH } = await import("../src/paths.mjs");

test("retired routed model state is atomic, private, and preserves only explicit successors", () => {
  const old = {
    slug: "provider/old",
    provider: "provider",
    upgradeTo: { model: "provider/new", markdown: "Switch" },
  };
  assert.equal(reconcileRetiredRoutedModels([old]).written, true);
  assert.equal(recordRetiredRoutedModels([old], "2026-08-12T00:00:00.000Z").written, true);

  const state = readRetiredRoutedModels();
  assert.equal(state.valid, true);
  assert.deepEqual(state.models[old.slug], {
    provider: "provider",
    successors: ["provider/new"],
    retiredAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(statSync(RETIRED_ROUTED_MODELS_PATH).mode & 0o777, 0o600);
  assert.equal(readFileSync(RETIRED_ROUTED_MODELS_PATH, "utf8").includes(".tmp."), false);
});

test("unreadable retired state is tolerated and never overwritten", () => {
  writeFileSync(RETIRED_ROUTED_MODELS_PATH, "{broken", { mode: 0o644 });
  const before = readFileSync(RETIRED_ROUTED_MODELS_PATH, "utf8");
  assert.deepEqual(readRetiredRoutedModels(), {
    exists: true,
    valid: false,
    models: {},
    active: {},
  });
  assert.deepEqual(reconcileRetiredRoutedModels([]), {
    written: false,
    reason: "invalid-state",
  });
  assert.equal(readFileSync(RETIRED_ROUTED_MODELS_PATH, "utf8"), before);
  chmodSync(RETIRED_ROUTED_MODELS_PATH, 0o600);
});
