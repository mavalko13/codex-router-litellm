import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { startAutoCurateStateWatcher } = await import("../src/auto-curate-watch.mjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeDirectoryWatch() {
  const listeners = new Map();
  let target;
  let closes = 0;
  const watcher = {
    on(event, listener) {
      listeners.set(event, listener);
      return watcher;
    },
    close() {
      closes += 1;
    },
  };
  return {
    watchImpl(directory) {
      target = directory;
      return watcher;
    },
    emit(event, ...args) {
      return listeners.get(event)?.(...args);
    },
    get target() {
      return target;
    },
    get closes() {
      return closes;
    },
  };
}

function settle(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the credential watcher filters to LiteLLM credential and endpoint files and coalesces changes", async () => {
  const directory = "/tmp/codex-router-watched-state";
  const fake = fakeDirectoryWatch();
  let refreshes = 0;
  const watcher = startAutoCurateStateWatcher({
    stateDir: directory,
    credentialFileName: "litellm-gateway-api-key.secret",
    endpointFileName: "litellm-gateway-base-url",
    watchImpl: fake.watchImpl,
    debounceMs: 5,
    onChange: () => { refreshes += 1; },
  });

  try {
    assert.equal(fake.target, directory);

    // A state-directory watcher is needed to tolerate atomic replacement, but
    // it must not treat caller secrets, catalog writes, or arbitrary state as
    // a provider credential/endpoint update.
    fake.emit("change", "change", "caller-secret");
    fake.emit("change", "rename", "merged-models.json");
    fake.emit("change", "change", "user-models.json");
    fake.emit("change", "change", undefined);
    await settle();
    assert.equal(refreshes, 0);

    // Editors and credential writers can produce multiple change/rename
    // events for one replacement. They must drive the existing refresh path
    // once, not create a restart storm.
    fake.emit("change", "change", "litellm-gateway-api-key.secret");
    fake.emit("change", "rename", "litellm-gateway-api-key.secret");
    fake.emit("change", "change", "litellm-gateway-base-url");
    await settle();
    assert.equal(refreshes, 1);
  } finally {
    watcher();
    assert.equal(fake.closes, 1);
  }
});

test("credential watcher errors and callback failures do not take down the service", async () => {
  const fake = fakeDirectoryWatch();
  let errors = 0;
  let changes = 0;
  const watcher = startAutoCurateStateWatcher({
    stateDir: "/tmp/codex-router-watched-state",
    credentialFileName: "litellm-gateway-api-key.secret",
    endpointFileName: "litellm-gateway-base-url",
    watchImpl: fake.watchImpl,
    debounceMs: 1,
    onChange: () => {
      changes += 1;
      throw new Error("refresh path temporarily unavailable");
    },
    onError: () => {
      errors += 1;
      throw new Error("logging must not crash the router either");
    },
  });

  try {
    assert.doesNotThrow(() => fake.emit("error", new Error("watch descriptor closed")));
    assert.equal(errors, 1);

    assert.doesNotThrow(() => fake.emit("change", "change", "litellm-gateway-base-url"));
    await settle();
    assert.equal(changes, 1);
  } finally {
    watcher();
  }
});

test("startup sends watched credential and endpoint changes through its existing auto-curate path", () => {
  const startup = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(startup, /startAutoCurateStateWatcher\(\{[\s\S]*?stateDir: STATE_DIR/);
  assert.match(startup, /endpointFileName: path\.basename\(PROVIDER_ENDPOINTS_PATH\)/);
  assert.match(startup, /runPeriodicAutoCurate\("watcher"\)/);
  assert.ok(
    startup.lastIndexOf("startPeriodicAutoCurate();") < startup.lastIndexOf("startLiteLlmGatewayStateWatcher();"),
    "the watcher is enabled only after the router has become ready",
  );
});
