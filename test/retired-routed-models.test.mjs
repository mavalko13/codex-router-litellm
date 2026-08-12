import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

function readSnapshot(file) {
  const descriptor = openSync(file, "r");
  try {
    return {
      mode: fstatSync(descriptor).mode & 0o777,
      text: readFileSync(descriptor, "utf8"),
    };
  } finally {
    closeSync(descriptor);
  }
}

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
  const snapshot = readSnapshot(RETIRED_ROUTED_MODELS_PATH);
  assert.equal(snapshot.mode, 0o600);
  assert.equal(snapshot.text.includes(".tmp."), false);
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
