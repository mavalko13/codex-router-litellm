import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupLegacyDesktop } from "../src/legacy-desktop-cleanup.mjs";

test("macOS cleanup removes only the retired companion bundle and its agent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-desktop-cleanup-"));
  try {
    const home = path.join(root, "home");
    const agents = path.join(home, "Library", "LaunchAgents");
    const plist = path.join(agents, "io.github.codex-router.tray.plist");
    const bundle = path.join(home, "Applications", "Model Router.app");
    const routerAgent = path.join(agents, "io.github.codex-router.plist");
    mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(bundle, "Contents", "MacOS", "ModelRouterTray"), "binary\n");
    mkdirSync(agents, { recursive: true });
    writeFileSync(plist, "tray\n");
    writeFileSync(routerAgent, "router\n");
    const calls = [];

    cleanupLegacyDesktop({
      platform: "darwin",
      home,
      launchAgentsDir: agents,
      execute: (command, args) => calls.push([command, args]),
    });

    assert.equal(existsSync(plist), false);
    assert.equal(existsSync(bundle), false);
    assert.equal(existsSync(routerAgent), true);
    assert.deepEqual(calls[0]?.[0], "launchctl");
    assert.deepEqual(calls[0]?.[1], ["bootout", `gui/${process.getuid()}/io.github.codex-router.tray`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS cleanup retains an unrelated bundle with the same display name", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-desktop-cleanup-unrelated-"));
  try {
    const home = path.join(root, "home");
    const bundle = path.join(home, "Applications", "Model Router.app");
    mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(bundle, "Contents", "MacOS", "OtherApp"), "binary\n");

    assert.deepEqual(
      cleanupLegacyDesktop({ platform: "darwin", home, execute: () => {} }),
      { removed: [] },
    );
    assert.equal(existsSync(bundle), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct CLI invocation works with a relative module path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-desktop-cleanup-cli-"));
  try {
    const home = path.join(root, "home");
    const bundle = path.join(home, "Applications", "Model Router.app", "Contents", "MacOS");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, "ModelRouterTray"), "binary\n");
    const env = { ...process.env, HOME: home };
    if (process.platform === "darwin") {
      const bin = path.join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const launchctl = path.join(bin, "launchctl");
      writeFileSync(launchctl, "#!/bin/sh\nexit 0\n");
      chmodSync(launchctl, 0o755);
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    }
    const result = spawnSync(process.execPath, ["src/legacy-desktop-cleanup.mjs"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    if (process.platform === "darwin") {
      assert.match(result.stdout, /Removed retired desktop companion files/);
      assert.equal(existsSync(path.join(home, "Applications", "Model Router.app")), false);
    } else {
      assert.equal(result.stdout, "");
      assert.equal(existsSync(path.join(home, "Applications", "Model Router.app")), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup does not change Linux installations", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-desktop-cleanup-linux-"));
  try {
    const home = path.join(root, "home");
    const bundle = path.join(home, "Applications", "Model Router.app");
    mkdirSync(bundle, { recursive: true });
    assert.deepEqual(cleanupLegacyDesktop({ platform: "linux", home }), { removed: [] });
    assert.equal(existsSync(bundle), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
