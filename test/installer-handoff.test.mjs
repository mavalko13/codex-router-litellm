import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transaction = path.join(root, "src", "install-transaction.mjs");

const initial = {
  config: "old config\n",
  backup: "old config backup\n",
  nativeSource: "old native source\n",
  internalSecret: "old internal secret\n",
  callerSecret: "old caller secret\n",
  nativeCatalog: "old native catalog\n",
  mergedCatalog: "old merged catalog\n",
  aliases: "old aliases\n",
  announced: "old announcements\n",
  litellm: "old LiteLLM config\n",
  userModels: "old user models\n",
  pending: "old pending marker\n",
  agent: "old agent\n",
  serviceDefinition: "old service definition\n",
  serviceRunning: "running\n",
};

function fakeCheckout(base, name) {
  const directory = path.join(base, name);
  mkdirSync(path.join(directory, "skills"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: `checkout-${name}`, version: "0.0.0" })}\n`,
    { mode: 0o600 },
  );
  return realpathSync(directory);
}

function manifest(sourceRoot) {
  return `${JSON.stringify({
    version: 1,
    current: { sourceRoot },
    history: [],
  })}\n`;
}

function writeFixture(base, owner) {
  const codexHome = path.join(base, "codex-home");
  const stateDir = path.join(base, "state");
  const agentsDir = path.join(codexHome, "agents");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const paths = {
    manifest: path.join(stateDir, "install-manifest.json"),
    config: path.join(codexHome, "config.toml"),
    backup: path.join(codexHome, "config.toml.pre-codex-router"),
    nativeSource: path.join(stateDir, "native-catalog-source.json"),
    internalSecret: path.join(stateDir, "internal-secret"),
    callerSecret: path.join(stateDir, "caller-secret"),
    nativeCatalog: path.join(stateDir, "native-models.json"),
    mergedCatalog: path.join(stateDir, "merged-models.json"),
    aliases: path.join(stateDir, "native-aliases.json"),
    announced: path.join(stateDir, "announced-models.json"),
    litellm: path.join(stateDir, "litellm.yaml"),
    userModels: path.join(stateDir, "user-models.json"),
    pending: path.join(stateDir, "auto-curate-refresh.pending"),
    agent: path.join(agentsDir, "router-model-old-provider-old.toml"),
    serviceDefinition: path.join(base, "service-definition"),
    serviceRunning: path.join(base, "service-running"),
    log: path.join(base, "steps.log"),
  };
  for (const [name, target] of Object.entries(paths)) {
    if (name === "log") continue;
    const contents = name === "manifest" ? manifest(owner) : initial[name];
    writeFileSync(target, contents, { mode: 0o600 });
  }
  return { codexHome, stateDir, paths };
}

function writeRunner(base) {
  const runner = path.join(base, "install-step-runner.mjs");
  writeFileSync(
    runner,
    `import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const [step, argument] = process.argv.slice(2);
const paths = JSON.parse(process.env.TEST_INSTALL_PATHS);
const append = (line) => writeFileSync(paths.log, line + "\\n", { flag: "a" });
append(step);
if (step === "service-snapshot") {
  writeFileSync(argument, JSON.stringify({
    definition: readFileSync(paths.serviceDefinition, "utf8"),
    running: readFileSync(paths.serviceRunning, "utf8"),
  }));
} else if (step === "service-stop") {
  writeFileSync(paths.serviceRunning, "stopped\\n");
} else if (step === "service-restore") {
  const snapshot = JSON.parse(readFileSync(argument, "utf8"));
  writeFileSync(paths.serviceDefinition, snapshot.definition);
  writeFileSync(paths.serviceRunning, snapshot.running);
} else if (step === "secret") {
  writeFileSync(paths.internalSecret, "new internal secret\\n");
  writeFileSync(paths.callerSecret, "new caller secret\\n");
} else if (step === "adoption") {
  writeFileSync(paths.nativeSource, "new native source\\n");
} else if (step === "auto-curate") {
  writeFileSync(paths.userModels, "new user models\\n");
  writeFileSync(paths.pending, "new pending marker\\n");
} else if (step === "catalog") {
  writeFileSync(paths.nativeCatalog, "new native catalog\\n");
  writeFileSync(paths.mergedCatalog, "new merged catalog\\n");
  writeFileSync(paths.aliases, "new aliases\\n");
  writeFileSync(paths.announced, "new announcements\\n");
  if (existsSync(paths.agent)) unlinkSync(paths.agent);
  writeFileSync(paths.agent.replace("old-provider-old", "new-provider-new"), "new agent\\n");
} else if (step === "litellm") {
  writeFileSync(paths.litellm, "new LiteLLM config\\n");
} else if (step === "auto-curate-commit") {
  if (existsSync(paths.pending)) unlinkSync(paths.pending);
} else if (step === "manifest") {
  const result = spawnSync(process.execPath, [process.env.TEST_MANIFEST_SCRIPT, "record"], {
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
} else if (step === "config") {
  writeFileSync(paths.config, "new config\\n");
  writeFileSync(paths.backup, "new config backup\\n");
} else if (step === "service") {
  const owner = JSON.parse(readFileSync(paths.manifest, "utf8")).current.sourceRoot;
  if (owner !== process.env.CODEX_ROUTER_SOURCE_ROOT) {
    throw new Error("service started before ownership handoff");
  }
  writeFileSync(paths.serviceDefinition, "new service definition\\n");
  writeFileSync(paths.serviceRunning, "running\\n");
}
`,
    { mode: 0o600 },
  );
  return runner;
}

function transactionEnv(fixture, checkout, runner, extra = {}) {
  return {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: fixture.stateDir,
    CODEX_HOME: fixture.codexHome,
    CODEX_ROUTER_SOURCE_ROOT: checkout,
    MODEL_ROUTER_REGISTRY: path.join(root, "config"),
    CODEX_ROUTER_INSTALL_TESTING: "1",
    CODEX_ROUTER_INSTALL_TEST_RUNNER: runner,
    TEST_INSTALL_PATHS: JSON.stringify(fixture.paths),
    TEST_MANIFEST_SCRIPT: path.join(root, "src", "install-manifest.mjs"),
    ...extra,
  };
}

function runTransaction(fixture, checkout, runner, args, extra = {}) {
  return spawnSync(process.execPath, [transaction, ...args], {
    cwd: root,
    encoding: "utf8",
    env: transactionEnv(fixture, checkout, runner, extra),
  });
}

function assertInitialState(fixture, oldOwner) {
  for (const [name, contents] of Object.entries(initial)) {
    assert.equal(readFileSync(fixture.paths[name], "utf8"), contents, name);
  }
  assert.equal(readFileSync(fixture.paths.manifest, "utf8"), manifest(oldOwner));
  assert.equal(
    existsSync(fixture.paths.agent.replace("old-provider-old", "new-provider-new")),
    false,
    "new managed agent must be removed",
  );
}

test("the production transaction restores every shared state layer after each failed step", () => {
  const failureSteps = [
    "secret",
    "adoption",
    "auto-curate",
    "catalog",
    "litellm",
    "auto-curate-commit",
    "manifest",
    "config",
    "service",
    "health",
  ];
  for (const failAfter of failureSteps) {
    const base = mkdtempSync(path.join(os.tmpdir(), `installer-${failAfter}-`));
    try {
      const oldOwner = fakeCheckout(base, "old");
      const newOwner = realpathSync(root);
      const fixture = writeFixture(base, oldOwner);
      const runner = writeRunner(base);
      const result = runTransaction(
        fixture,
        newOwner,
        runner,
        ["apply", "--adopt-native-catalog"],
        { CODEX_ROUTER_INSTALL_FAIL_AFTER: failAfter },
      );
      assert.equal(result.status, 1, `${failAfter}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`Injected failure after ${failAfter}`));
      assertInitialState(fixture, oldOwner);
      const steps = readFileSync(fixture.paths.log, "utf8").trim().split("\n");
      assert.equal(steps.at(-2), "service-stop", failAfter);
      assert.equal(steps.at(-1), "service-restore", failAfter);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("the successful transaction transfers ownership before the new service starts", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "installer-success-"));
  try {
    const oldOwner = fakeCheckout(base, "old");
    const newOwner = realpathSync(root);
    const fixture = writeFixture(base, oldOwner);
    const runner = writeRunner(base);
    const result = runTransaction(
      fixture,
      newOwner,
      runner,
      ["apply", "--adopt-native-catalog"],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(fixture.paths.manifest, "utf8")).current.sourceRoot, newOwner);
    assert.equal(readFileSync(fixture.paths.serviceDefinition, "utf8"), "new service definition\n");
    const steps = readFileSync(fixture.paths.log, "utf8").trim().split("\n");
    assert.ok(steps.indexOf("manifest") < steps.indexOf("service"), steps.join(", "));
    assert.ok(steps.indexOf("auto-curate") < steps.indexOf("litellm"), steps.join(", "));
    assert.ok(steps.indexOf("litellm") < steps.indexOf("catalog"), steps.join(", "));
    assert.ok(steps.indexOf("catalog") < steps.indexOf("auto-curate-commit"), steps.join(", "));
    assert.equal(existsSync(fixture.paths.pending), false);
    assert.deepEqual(steps.slice(-3), ["config", "service", "health"]);
    assert.equal(steps.includes("service-stop"), false);
    assert.equal(steps.includes("service-restore"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("prepare-only from a foreign checkout refuses before touching shared live state", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "installer-prepare-"));
  try {
    const oldOwner = fakeCheckout(base, "old");
    const foreignCheckout = fakeCheckout(base, "foreign");
    const fixture = writeFixture(base, oldOwner);
    const runner = writeRunner(base);
    const result = runTransaction(fixture, foreignCheckout, runner, ["prepare"], {
      // A leaked/manual override must not weaken prepare-only's no-handoff contract.
      MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owned by another checkout/);
    assertInitialState(fixture, oldOwner);
    assert.equal(existsSync(fixture.paths.log), false, "no mutating step may run");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("both platform installers delegate critical state changes to the shared transaction", () => {
  const posix = readFileSync(path.join(root, "bin", "install"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(posix, /install-transaction\.mjs "\$@"/);
  assert.match(posix, /install-transaction\.mjs prepare/);
  assert.match(windows, /install-transaction\.mjs", "apply"/);
  assert.match(windows, /install-transaction\.mjs prepare/);
  for (const source of [posix, windows]) {
    assert.equal(source.includes("src/service.mjs install"), false);
    assert.equal(source.includes("src/config-manager.mjs enable"), false);
    assert.equal(source.includes("src/install-manifest.mjs record"), false);
  }
});
