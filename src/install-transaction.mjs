import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  AUTO_CURATE_PENDING_PATH,
  clearAutoCurateRefreshPending,
} from "./auto-curate-state.mjs";
import {
  ANNOUNCED_MODELS_PATH,
  BACKUP_PATH,
  CALLER_SECRET_PATH,
  CODEX_AGENTS_DIR,
  CODEX_PROVIDER_MODE_PATH,
  CONFIG_PATH,
  INSTALL_MANIFEST_PATH,
  INTERNAL_SECRET_PATH,
  LIVE_MODEL_METADATA_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
  NATIVE_CATALOG_SOURCE_PATH,
  SOURCE_ROOT,
} from "./paths.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { USER_MODELS_PATH } from "./user-models.mjs";

// "apply" deliberately avoids the generic "install" argv token: this module
// imports manifest provenance helpers, and one of their transitive libraries
// also exposes a standalone `install` command.
const command = process.argv[2] || "apply";
const adoptNativeCatalog = process.argv.includes("--adopt-native-catalog");
const managedAgentFile = /^router-model-[a-z0-9-]+\.toml$/;
const overrideEnv = "MODEL_ROUTER_ALLOW_FOREIGN_STATE";
const testRunner = process.env.CODEX_ROUTER_INSTALL_TEST_RUNNER;
const testing = process.env.CODEX_ROUTER_INSTALL_TESTING === "1";
const failAfter = testing ? process.env.CODEX_ROUTER_INSTALL_FAIL_AFTER : undefined;
let activeSnapshotDir;
let rollbackInProgress = false;

const sharedFiles = [
  INSTALL_MANIFEST_PATH,
  CONFIG_PATH,
  BACKUP_PATH,
  CODEX_PROVIDER_MODE_PATH,
  NATIVE_CATALOG_SOURCE_PATH,
  INTERNAL_SECRET_PATH,
  CALLER_SECRET_PATH,
  NATIVE_CATALOG_PATH,
  MERGED_CATALOG_PATH,
  NATIVE_ALIAS_PATH,
  ANNOUNCED_MODELS_PATH,
  LIVE_MODEL_METADATA_PATH,
  LITELLM_CONFIG_PATH,
  USER_MODELS_PATH,
  AUTO_CURATE_PENDING_PATH,
];

function runNode(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, script), ...args], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.quiet ? String(result.stderr || "").trim() : "";
    throw new Error(`${options.label || script} failed${detail ? `: ${detail}` : "."}`);
  }
}

function runTestStep(step, args = []) {
  if (!testing || !testRunner) return false;
  if (!path.isAbsolute(testRunner)) {
    throw new Error("CODEX_ROUTER_INSTALL_TEST_RUNNER must be an absolute path.");
  }
  const result = spawnSync(process.execPath, [testRunner, step, ...args], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Install step ${step} failed.`);
  return true;
}

function maybeFail(step) {
  if (failAfter === step) throw new Error(`Injected failure after ${step}.`);
}

function runStep(step, args = []) {
  if (runTestStep(step, args)) {
    maybeFail(step);
    return;
  }
  if (step === "secret") {
    runNode("src/secret.mjs", ["ensure"]);
  } else if (step === "adoption") {
    runNode("src/native-catalog-source.mjs", ["prepare-from-config"], { quiet: true });
  } else if (step === "auto-curate") {
    runNode("src/auto-curate-models.mjs");
  } else if (step === "catalog") {
    const hasNativeCatalog =
      existsSync(NATIVE_CATALOG_PATH) && statSync(NATIVE_CATALOG_PATH).size > 0;
    runNode(
      "src/catalog.mjs",
      hasNativeCatalog
        ? []
        : ["--refresh-native", ...(process.platform === "win32" ? [] : ["--bundled-native"])],
    );
  } else if (step === "litellm") {
    runNode("src/litellm-config.mjs");
  } else if (step === "auto-curate-commit") {
    clearAutoCurateRefreshPending();
  } else if (step === "manifest") {
    runNode("src/install-manifest.mjs", ["record"], { quiet: true });
  } else if (step === "config") {
    runNode(
      "src/config-manager.mjs",
      ["enable", ...(adoptNativeCatalog ? ["--adopt-native-catalog"] : [])],
    );
  } else if (step === "service") {
    runNode("src/service.mjs", ["install"]);
  } else if (step === "health") {
    runNode("src/wait-health.mjs");
  } else {
    throw new Error(`Unknown install transaction step: ${step}`);
  }
  maybeFail(step);
}

function serviceOperation(operation, snapshotPath) {
  if (runTestStep(`service-${operation}`, snapshotPath ? [snapshotPath] : [])) return;
  runNode(
    "src/service.mjs",
    [operation, ...(snapshotPath ? [snapshotPath] : [])],
    { quiet: true, label: `Background-service ${operation}` },
  );
}

function fileRecord(target, snapshotDir, index) {
  if (!existsSync(target)) return { target, present: false };
  const stats = statSync(target);
  if (!stats.isFile()) throw new Error(`Cannot snapshot non-file installer state: ${target}`);
  const blob = `file-${index}`;
  copyFileSync(target, path.join(snapshotDir, blob));
  chmodSync(path.join(snapshotDir, blob), 0o600);
  return { target, present: true, blob, mode: stats.mode & 0o777 };
}

function managedAgents() {
  try {
    return readdirSync(CODEX_AGENTS_DIR).filter((entry) => managedAgentFile.test(entry));
  } catch {
    return [];
  }
}

function beginSnapshot() {
  const snapshotDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-install-"));
  chmodSync(snapshotDir, 0o700);
  try {
    const files = sharedFiles.map((target, index) => fileRecord(target, snapshotDir, index));
    const agents = managedAgents().map((entry, index) =>
      fileRecord(path.join(CODEX_AGENTS_DIR, entry), snapshotDir, sharedFiles.length + index),
    );
    const serviceSnapshot = path.join(snapshotDir, "service.json");
    serviceOperation("snapshot", serviceSnapshot);
    const snapshot = { version: 1, files, agents, serviceSnapshot };
    writeFileSync(
      path.join(snapshotDir, "transaction.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    protectPrivateFile(path.join(snapshotDir, "transaction.json"));
    return snapshotDir;
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

function restoreFile(record, snapshotDir) {
  if (!record.present) {
    if (existsSync(record.target)) unlinkSync(record.target);
    return;
  }
  mkdirSync(path.dirname(record.target), { recursive: true, mode: 0o700 });
  const temporary = `${record.target}.install-restore.${process.pid}`;
  copyFileSync(path.join(snapshotDir, record.blob), temporary);
  chmodSync(temporary, record.mode);
  renameSync(temporary, record.target);
  chmodSync(record.target, record.mode);
}

function rollback(snapshotDir) {
  const snapshot = JSON.parse(
    readFileSync(path.join(snapshotDir, "transaction.json"), "utf8"),
  );
  const errors = [];
  try {
    serviceOperation("stop");
  } catch (error) {
    errors.push(error);
  }
  for (const record of snapshot.files) {
    try {
      restoreFile(record, snapshotDir);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    mkdirSync(CODEX_AGENTS_DIR, { recursive: true, mode: 0o700 });
    for (const entry of managedAgents()) unlinkSync(path.join(CODEX_AGENTS_DIR, entry));
    for (const record of snapshot.agents) restoreFile(record, snapshotDir);
  } catch (error) {
    errors.push(error);
  }
  try {
    serviceOperation("restore", snapshot.serviceSnapshot);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      `Install rollback was incomplete; recovery snapshot kept at ${snapshotDir}.`,
    );
  }
  rmSync(snapshotDir, { recursive: true, force: true });
}

for (const [signal, exitCode] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    if (activeSnapshotDir && !rollbackInProgress) {
      rollbackInProgress = true;
      try {
        rollback(activeSnapshotDir);
        activeSnapshotDir = undefined;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    process.exit(exitCode);
  });
}

function prepare() {
  // A foreign checkout may build its private dependencies, but it must not
  // rewrite the live state directory when --prepare-only was explicitly chosen.
  assertStateOwnership("prepare shared router state", { allowOverride: false });
  runStep("secret");
  runStep("catalog");
  runStep("litellm");
}

function install() {
  const snapshotDir = beginSnapshot();
  activeSnapshotDir = snapshotDir;
  const previousOverride = process.env[overrideEnv];
  process.env[overrideEnv] = "1";
  try {
    runStep("secret");
    if (adoptNativeCatalog) runStep("adoption");
    // Every generator runs in a fresh Node process because model-registry.mjs
    // snapshots user-models.json at module load. Publish routes before the
    // picker so a failed catalog build can never advertise an unroutable ID.
    runStep("auto-curate");
    runStep("litellm");
    runStep("catalog");
    runStep("auto-curate-commit");
    // Ownership is transferred before configuration starts the new service.
    runStep("manifest");
    runStep("config");
    runStep("service");
    runStep("health");
    rmSync(snapshotDir, { recursive: true, force: true });
    activeSnapshotDir = undefined;
  } catch (error) {
    try {
      rollbackInProgress = true;
      rollback(snapshotDir);
      activeSnapshotDir = undefined;
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Installation failed and the previous router state could not be fully restored.",
      );
    }
    throw error;
  } finally {
    rollbackInProgress = false;
    if (previousOverride === undefined) delete process.env[overrideEnv];
    else process.env[overrideEnv] = previousOverride;
  }
}

try {
  if (command === "prepare") prepare();
  else if (command === "apply") install();
  else {
    console.error("Usage: install-transaction.mjs prepare|apply [--adopt-native-catalog]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      console.error(`  ${nested instanceof Error ? nested.message : String(nested)}`);
    }
  }
  process.exitCode = 1;
}
