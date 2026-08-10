import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  terminateWindowsProcessTrees,
  windowsProcessTreeStopScript,
} from "../src/windows-process-tree.mjs";

test("the Windows tree terminator matches only the exact start script and keeps native stderr visible", () => {
  const script = windowsProcessTreeStopScript();
  assert.match(script, /CODEX_ROUTER_START_SCRIPT/);
  assert.match(script, /OrdinalIgnoreCase/);
  assert.match(script, /taskkill\.exe \/PID \$process\.ProcessId \/T \/F/);
  assert.doesNotMatch(script, /2>\$null/);
});

test(
  "Windows terminates the owned Node tree without touching another Node process",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-tree-"));
    const ownedScript = path.join(directory, "owned-start.mjs");
    const unrelatedScript = path.join(directory, "unrelated.mjs");
    const body = "setInterval(() => {}, 1000);\n";
    writeFileSync(ownedScript, body);
    writeFileSync(unrelatedScript, body);
    const owned = spawn(process.execPath, [ownedScript], { stdio: "ignore" });
    const unrelated = spawn(process.execPath, [unrelatedScript], { stdio: "ignore" });
    const ownedExit = new Promise((resolve) => owned.once("exit", resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      terminateWindowsProcessTrees(ownedScript);
      await ownedExit;
      assert.ok(owned.exitCode !== null || owned.signalCode !== null);
      assert.equal(unrelated.exitCode, null);
    } finally {
      if (owned.exitCode === null && owned.signalCode === null) owned.kill();
      if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
