import { execFileSync } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRAY_SERVICE_LABEL = "io.github.codex-router.tray";

function removeLegacyBundle(target) {
  const marker = path.join(target, "Contents", "MacOS", "ModelRouterTray");
  if (!existsSync(marker)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

function unloadMacAgent(plist, execute = execFileSync) {
  try {
    execute("launchctl", ["bootout", `gui/${process.getuid()}/${TRAY_SERVICE_LABEL}`], { stdio: "ignore" });
  } catch {
    // A stale or already-unloaded label is safe to remove below.
  }
  if (!existsSync(plist)) return false;
  unlinkSync(plist);
  return true;
}

export function cleanupLegacyDesktop({
  platform = process.platform,
  home = os.homedir(),
  launchAgentsDir = path.join(home, "Library", "LaunchAgents"),
  execute = execFileSync,
} = {}) {
  const removed = [];
  if (platform === "darwin") {
    const agent = path.join(launchAgentsDir, `${TRAY_SERVICE_LABEL}.plist`);
    if (unloadMacAgent(agent, execute)) removed.push(agent);
    for (const bundle of [
      path.join(home, "Applications", "Model Router.app"),
      path.join(home, ".local", "share", "codex-router", "dist", "Model Router.app"),
    ]) {
      if (removeLegacyBundle(bundle)) removed.push(bundle);
    }
  }
  return { removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { removed } = cleanupLegacyDesktop();
  if (removed.length) process.stdout.write(`Removed retired desktop companion files: ${removed.join(", ")}\n`);
}
