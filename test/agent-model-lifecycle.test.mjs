import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import lockfile from "proper-lockfile";

import {
  codexAgentModelReferenceStatus,
  reconcileCodexAgentModelReferences,
  resolveAgentModelSuccessor,
} from "../src/agent-model-lifecycle.mjs";

const staleLuna = "litellm-gateway/codex-gpt-5.6-luna";
const routedLuna = `${staleLuna}-no-fallback`;

const catalog = [
  { slug: "gpt-5.6-terra", visibility: "list", multi_agent_version: "v2" },
  { slug: routedLuna, visibility: "list", multi_agent_version: "v1" },
];

function fixture() {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-agent-models-"));
  const agentsDir = path.join(codexHome, "agents");
  const configPath = path.join(codexHome, "config.toml");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  return { agentsDir, configPath };
}

test("successor resolution accepts only the exact no-fallback alias", () => {
  assert.equal(resolveAgentModelSuccessor(staleLuna, new Set([routedLuna])), routedLuna);
  assert.equal(
    resolveAgentModelSuccessor(staleLuna, new Set(["other/codex-gpt-5.6-luna-no-fallback"])),
    undefined,
  );
});

test("role references migrate without making a v1 alias the global default", () => {
  const { agentsDir, configPath } = fixture();
  const explorerPath = path.join(agentsDir, "explorer.toml");
  const config = `[agents]\n# Keep this operator comment.\ndefault_subagent_model = "${staleLuna}"\ndefault_subagent_reasoning_effort = "medium"\n`;
  const explorer = `name = "explorer"\ndescription = "Keep this description."\nmodel_provider = "codex-router"\nmodel = "${staleLuna}" # preserve inline comment\n\ndeveloper_instructions = """\nKeep these instructions exactly.\n"""\n`;
  writeFileSync(configPath, config, { mode: 0o600 });
  writeFileSync(explorerPath, explorer, { mode: 0o644 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.equal(readFileSync(configPath, "utf8"), config);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0].path, explorerPath);
  assert.equal(result.repaired[0].replacement, routedLuna);
  assert.deepEqual(
    result.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [{ target: configPath, reference: staleLuna }],
  );
  assert.equal(
    readFileSync(explorerPath, "utf8"),
    explorer.replace(`model = "${staleLuna}"`, `model = "${routedLuna}"`),
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(explorerPath).mode & 0o777, 0o600);
  }
});

test("global default migrates only to an exact visible v2 successor", () => {
  const { agentsDir, configPath } = fixture();
  const visibleV2 = `${staleLuna}-no-fallback`;
  writeFileSync(
    configPath,
    `[agents]\ndefault_subagent_model = "${staleLuna}"\n`,
    { mode: 0o600 },
  );

  const result = reconcileCodexAgentModelReferences({
    availableModels: [{ slug: visibleV2, visibility: "list", multi_agent_version: "v2" }],
    configPath,
    agentsDir,
  });

  assert.deepEqual(result.unresolved, []);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0].replacement, visibleV2);
  assert.match(readFileSync(configPath, "utf8"), new RegExp(`default_subagent_model = "${visibleV2}"`));
});

test("quoted agents table names retain global-default repair semantics", () => {
  for (const table of ['["agents"]', "['agents']"]) {
    const { agentsDir, configPath } = fixture();
    const original = `${table}\n"default_subagent_model" = "${staleLuna}" # keep\n`;
    writeFileSync(configPath, original, { mode: 0o600 });

    const result = reconcileCodexAgentModelReferences({
      availableModels: [{ slug: routedLuna, visibility: "list", multi_agent_version: "v2" }],
      configPath,
      agentsDir,
    });

    assert.equal(result.repaired.length, 1, table);
    assert.equal(
      readFileSync(configPath, "utf8"),
      original.replace(`"${staleLuna}"`, `"${routedLuna}"`),
      table,
    );
  }
});

test("a hidden v2 successor does not validate or migrate the global default", () => {
  const { agentsDir, configPath } = fixture();
  const original = `[agents]\ndefault_subagent_model = "${staleLuna}"\n`;
  writeFileSync(configPath, original, { mode: 0o600 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: [{ slug: routedLuna, visibility: "hide", multi_agent_version: "v2" }],
    configPath,
    agentsDir,
  });

  assert.equal(result.repaired.length, 0);
  assert.deepEqual(result.unresolved.map(({ reference }) => reference), [staleLuna]);
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("all valid segmented dotted root default key forms are repaired byte-surgically", () => {
  const forms = [
    "agents.default_subagent_model",
    'agents."default_subagent_model"',
    '"agents".default_subagent_model',
    "agents . default_subagent_model",
    "'agents'.'default_subagent_model'",
  ];
  for (const key of forms) {
    const { agentsDir, configPath } = fixture();
    const original = `# root form\n${key} = "${staleLuna}" # keep\n`;
    writeFileSync(configPath, original, { mode: 0o600 });

    const result = reconcileCodexAgentModelReferences({
      availableModels: [{ slug: routedLuna, visibility: "list", multi_agent_version: "v2" }],
      configPath,
      agentsDir,
    });

    assert.equal(result.repaired.length, 1, key);
    assert.equal(
      readFileSync(configPath, "utf8"),
      original.replace(`"${staleLuna}"`, `"${routedLuna}"`),
      key,
    );
  }
});

test("a whole-quoted dotted key is a literal root key and remains untouched", () => {
  const { agentsDir, configPath } = fixture();
  const original = `"agents.default_subagent_model" = "${staleLuna}" # literal key\n`;
  writeFileSync(configPath, original, { mode: 0o600 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: [{ slug: routedLuna, visibility: "list", multi_agent_version: "v2" }],
    configPath,
    agentsDir,
  });

  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.repaired, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("valid defaults and roles remain byte-identical", () => {
  const { agentsDir, configPath } = fixture();
  const reviewerPath = path.join(agentsDir, "reviewer.toml");
  const config = `[agents]\ndefault_subagent_model = "gpt-5.6-terra"\n`;
  const reviewer = `name = "reviewer"\nmodel_provider = "codex-router"\nmodel = "${routedLuna}"\n`;
  writeFileSync(configPath, config, { mode: 0o600 });
  writeFileSync(reviewerPath, reviewer, { mode: 0o600 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.equal(result.unresolved.length, 0);
  assert.equal(result.repaired.length, 0);
  assert.equal(result.valid.length, 2);
  assert.equal(readFileSync(configPath, "utf8"), config);
  assert.equal(readFileSync(reviewerPath, "utf8"), reviewer);
});

test("unknown or user-provider role references are reported and never guessed", () => {
  const { agentsDir, configPath } = fixture();
  const customPath = path.join(agentsDir, "custom.toml");
  const custom = `name = "custom"\nmodel_provider = "openai"\nmodel = "removed/model"\n`;
  writeFileSync(configPath, "model = \"gpt-5.6-terra\"\n", { mode: 0o600 });
  writeFileSync(customPath, custom, { mode: 0o600 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.equal(result.repaired.length, 0);
  assert.deepEqual(
    result.unresolved.map(({ path: target, reference, candidates }) => ({
      target,
      reference,
      candidates,
    })),
    [{ target: customPath, reference: "removed/model", candidates: [] }],
  );
  assert.equal(readFileSync(customPath, "utf8"), custom);
});

test("quoted role model keys repair only for the quoted codex-router provider", () => {
  const { agentsDir, configPath } = fixture();
  const repairablePath = path.join(agentsDir, "repairable.toml");
  const userPath = path.join(agentsDir, "user-owned.toml");
  const repairable = `"model_provider" = "codex-router"\n"model" = "${staleLuna}" # keep\n`;
  const userOwned = `'model_provider' = "openai"\n'model' = "${staleLuna}"\n`;
  writeFileSync(configPath, 'model = "gpt-5.6-terra"\n', { mode: 0o600 });
  writeFileSync(repairablePath, repairable, { mode: 0o600 });
  writeFileSync(userPath, userOwned, { mode: 0o600 });

  const result = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.deepEqual(result.repaired.map(({ path: target }) => target), [repairablePath]);
  assert.deepEqual(
    result.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [{ target: userPath, reference: staleLuna }],
  );
  assert.equal(
    readFileSync(repairablePath, "utf8"),
    repairable.replace(`"${staleLuna}"`, `"${routedLuna}"`),
  );
  assert.equal(readFileSync(userPath, "utf8"), userOwned);
});

test("read-only status exposes exact unresolved files and references", () => {
  const { agentsDir, configPath } = fixture();
  const testerPath = path.join(agentsDir, "tester.toml");
  writeFileSync(
    configPath,
    `[agents]\ndefault_subagent_model = "${staleLuna}"\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    testerPath,
    `name = "tester"\nmodel_provider = "codex-router"\nmodel = "missing/tester"\n`,
    { mode: 0o600 },
  );

  const status = codexAgentModelReferenceStatus({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.equal(status.ok, false);
  assert.deepEqual(
    status.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [
      { target: configPath, reference: staleLuna },
      { target: testerPath, reference: "missing/tester" },
    ],
  );
});

test("a concurrent manual edit is never overwritten with stale repair offsets", () => {
  const { agentsDir, configPath } = fixture();
  const explorerPath = path.join(agentsDir, "explorer.toml");
  const manual = `model_provider = "codex-router"\nmodel = "${routedLuna}"\n# edited by operator\n`;
  writeFileSync(
    explorerPath,
    `model_provider = "codex-router"\nmodel = "${staleLuna}"\n`,
    { mode: 0o600 },
  );

  const release = lockfile.lockSync(explorerPath, {
    realpath: false,
    stale: 90_000,
    update: 10_000,
    retries: 0,
  });
  try {
    // A manual writer can update the bytes while a repair is waiting. The
    // repair must fail closed while locked rather than applying old offsets.
    writeFileSync(explorerPath, manual, { mode: 0o600 });
    const locked = reconcileCodexAgentModelReferences({
      availableModels: catalog,
      configPath,
      agentsDir,
    });
    assert.equal(locked.repaired.length, 0);
    assert.equal(readFileSync(explorerPath, "utf8"), manual);
  } finally {
    release();
  }

  const afterRelease = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });
  assert.equal(afterRelease.repaired.length, 0);
  assert.equal(readFileSync(explorerPath, "utf8"), manual);
});

test("repair refuses a symlinked role file without changing its target", { skip: process.platform === "win32" }, () => {
  const { agentsDir, configPath } = fixture();
  const targetPath = path.join(path.dirname(agentsDir), "operator-role.toml");
  const rolePath = path.join(agentsDir, "explorer.toml");
  const original = `model_provider = "codex-router"\nmodel = "${staleLuna}"\n`;
  writeFileSync(targetPath, original, { mode: 0o600 });
  symlinkSync(targetPath, rolePath);

  const result = reconcileCodexAgentModelReferences({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.equal(result.repaired.length, 0);
  assert.equal(lstatSync(rolePath).isSymbolicLink(), true);
  assert.equal(readFileSync(targetPath, "utf8"), original);
  assert.deepEqual(
    result.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [{ target: rolePath, reference: "<non-regular>" }],
  );
});

test("repair refuses a symlinked config without changing its target", { skip: process.platform === "win32" }, () => {
  const { agentsDir, configPath } = fixture();
  const targetPath = path.join(path.dirname(agentsDir), "operator-config.toml");
  const original = `[agents]\ndefault_subagent_model = "${staleLuna}"\n`;
  writeFileSync(targetPath, original, { mode: 0o600 });
  symlinkSync(targetPath, configPath);

  const result = reconcileCodexAgentModelReferences({
    availableModels: [{ slug: routedLuna, visibility: "list", multi_agent_version: "v2" }],
    configPath,
    agentsDir,
  });

  assert.equal(result.repaired.length, 0);
  assert.equal(lstatSync(configPath).isSymbolicLink(), true);
  assert.equal(readFileSync(targetPath, "utf8"), original);
  assert.deepEqual(
    result.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [{ target: configPath, reference: "<non-regular>" }],
  );
});

test("a FIFO is reported without opening it", { skip: process.platform === "win32" }, () => {
  const { agentsDir, configPath } = fixture();
  const fifoPath = path.join(agentsDir, "explorer.toml");
  execFileSync("mkfifo", [fifoPath]);

  const status = codexAgentModelReferenceStatus({
    availableModels: catalog,
    configPath,
    agentsDir,
  });

  assert.deepEqual(
    status.unresolved.map(({ path: target, reference }) => ({ target, reference })),
    [{ target: fifoPath, reference: "<non-regular>" }],
  );
});
