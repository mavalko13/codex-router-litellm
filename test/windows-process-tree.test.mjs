import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  terminateWindowsProcessTrees,
  windowsProcessTreeStopScript,
} from "../src/windows-process-tree.mjs";

function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function forceKillTestProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch {
    child.kill();
  }
}

test("the Windows tree terminator matches only the exact start script and keeps native stderr visible", () => {
  const script = windowsProcessTreeStopScript();
  assert.match(script, /CODEX_ROUTER_START_SCRIPT/);
  assert.match(script, /OrdinalIgnoreCase/);
  assert.match(script, /taskkill\.exe \/PID \$process\.ProcessId \/T \/F/);
  assert.doesNotMatch(script, /2>\$null/);
});

test(
  "Windows terminates the owned Node tree without touching another Node process",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-tree-"));
    const ownedScript = path.join(directory, "owned-start.mjs");
    const unrelatedScript = path.join(directory, "unrelated.mjs");
    const body = "setInterval(() => {}, 1000);\n";
    writeFileSync(ownedScript, body);
    writeFileSync(unrelatedScript, body);
    // GitHub's Windows runner can expose TEMP through an 8.3 alias such as
    // RUNNER~1 while CIM reports the long path. Spawn and match the same native
    // canonical path so the test exercises process ownership, not path aliases.
    const canonicalOwnedScript = realpathSync.native(ownedScript);
    const canonicalUnrelatedScript = realpathSync.native(unrelatedScript);
    const owned = spawn(process.execPath, [canonicalOwnedScript], { stdio: "ignore" });
    const unrelated = spawn(process.execPath, [canonicalUnrelatedScript], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      terminateWindowsProcessTrees(canonicalOwnedScript);
      await waitForChildExit(owned);
      assert.ok(owned.exitCode !== null || owned.signalCode !== null);
      assert.equal(unrelated.exitCode, null);
    } finally {
      forceKillTestProcess(owned);
      forceKillTestProcess(unrelated);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
