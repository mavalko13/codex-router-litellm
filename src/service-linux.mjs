import { execFileSync } from "node:child_process";
import { rotateLog } from "./log-rotation.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_HOME,
  LOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  TARGET_DISPLAY_NAME,
} from "./paths.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const nodeBinary = process.env.CODEX_ROUTER_NODE_BIN || process.execPath;
const systemctlBinary = process.env.CODEX_ROUTER_SYSTEMCTL_BIN || "systemctl";
const systemctlPrefixArgs = (() => {
  if (!process.env.CODEX_ROUTER_SYSTEMCTL_ARGS_JSON) return [];
  const parsed = JSON.parse(process.env.CODEX_ROUTER_SYSTEMCTL_ARGS_JSON);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("CODEX_ROUTER_SYSTEMCTL_ARGS_JSON must be a JSON string array.");
  }
  return parsed;
})();
if (!path.isAbsolute(nodeBinary)) {
  throw new Error("CODEX_ROUTER_NODE_BIN must be an absolute path.");
}
if (process.env.CODEX_ROUTER_SYSTEMCTL_BIN && !path.isAbsolute(systemctlBinary)) {
  throw new Error("CODEX_ROUTER_SYSTEMCTL_BIN must be an absolute path.");
}
const unitName = "codex-router.service";
const unitPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "systemd",
  "user",
  unitName,
);

if (effectivePlatform !== "linux" && command !== "render") {
  throw new Error("The systemd service manager runs on Linux only.");
}

function systemdQuote(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function unit() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  const environment = {
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
    ...(process.env.CODEX_ROUTER_SOURCE_ROOT
      ? { CODEX_ROUTER_SOURCE_ROOT: SOURCE_ROOT }
      : {}),
    ...(process.env.CODEX_ROUTER_NODE_BIN
      ? { CODEX_ROUTER_NODE_BIN: nodeBinary }
      : {}),
    ...(process.env.CODEX_ROUTER_PACKAGE_MANAGER
      ? { CODEX_ROUTER_PACKAGE_MANAGER: process.env.CODEX_ROUTER_PACKAGE_MANAGER }
      : {}),
  };
  return `[Unit]
Description=${TARGET_DISPLAY_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${String(SOURCE_ROOT).replaceAll("%", "%%")}
ExecStart=${systemdQuote(nodeBinary)} ${systemdQuote(start)}
Restart=always
RestartSec=5
${Object.entries(environment)
  .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
  .join("\n")}
StandardOutput=append:${String(LOG_PATH).replaceAll("%", "%%")}
StandardError=append:${String(LOG_PATH).replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`;
}

function systemctl(args, options = {}) {
  return execFileSync(systemctlBinary, [...systemctlPrefixArgs, "--user", ...args], {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeUnit() {
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp.${process.pid}`;
  writeFileSync(temporary, unit(), { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, unitPath);
}

function snapshotPath() {
  const target = process.argv[3];
  if (!target || !path.isAbsolute(target)) {
    throw new Error(`${command} requires an absolute snapshot path.`);
  }
  return target;
}

function unitSnapshot() {
  if (!existsSync(unitPath)) return { present: false };
  return {
    present: true,
    contents: readFileSync(unitPath).toString("base64"),
    mode: statSync(unitPath).mode & 0o777,
  };
}

function serviceIsActive() {
  try {
    return systemctl(["is-active", unitName]).trim() === "active";
  } catch {
    return false;
  }
}

function serviceIsEnabled() {
  try {
    return systemctl(["is-enabled", unitName]).trim() === "enabled";
  } catch {
    return false;
  }
}

function restoreUnit(definition) {
  if (!definition?.present) {
    if (existsSync(unitPath)) unlinkSync(unitPath);
    return;
  }
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.restore.${process.pid}`;
  writeFileSync(temporary, Buffer.from(definition.contents, "base64"), {
    mode: definition.mode,
  });
  chmodSync(temporary, definition.mode);
  renameSync(temporary, unitPath);
}

function writeServiceSnapshot(target) {
  const definition = unitSnapshot();
  const running = serviceIsActive();
  if (running && !definition.present) {
    throw new Error("Cannot snapshot an active systemd service without its unit definition.");
  }
  const snapshot = {
    version: 1,
    platform: "linux",
    definition,
    enabled: serviceIsEnabled(),
    running,
  };
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(target, 0o600);
}

function restoreServiceSnapshot(target) {
  const snapshot = JSON.parse(readFileSync(target, "utf8"));
  if (snapshot?.version !== 1 || snapshot.platform !== "linux") {
    throw new Error(`Invalid systemd service snapshot: ${target}`);
  }
  try {
    systemctl(["disable", "--now", unitName], { quiet: true });
  } catch {
    // A partially installed or already missing unit is still replaceable.
  }
  restoreUnit(snapshot.definition);
  systemctl(["daemon-reload"], { quiet: true });
  if (!snapshot.definition?.present) return;
  if (snapshot.enabled) systemctl(["enable", unitName], { quiet: true });
  else {
    try {
      systemctl(["disable", unitName], { quiet: true });
    } catch {
      // A disabled unit is already the requested state.
    }
  }
  if (snapshot.running) systemctl(["start", unitName], { quiet: true });
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render", "snapshot", "restore"]).has(command)) {
  console.error("Usage: service-linux.mjs install|uninstall|start|stop|restart|status|render|snapshot|restore");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(unit());
} else if (command === "snapshot") {
  writeServiceSnapshot(snapshotPath());
} else if (command === "restore") {
  restoreServiceSnapshot(snapshotPath());
} else if (command === "install") {
  writeUnit();
  systemctl(["daemon-reload"], { quiet: true });
  // systemd's append: opens the log before the service runs, so the started
  // process cannot rotate a file it already holds open. Stop first, rotate
  // while nothing holds it, then start: enable --now on an already-running
  // unit would otherwise leave the old descriptor on the renamed inode.
  systemctl(["stop", unitName], { quiet: true });
  rotateLog(LOG_PATH);
  systemctl(["enable", "--now", unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ installed: true, path: unitPath })}\n`);
} else if (command === "uninstall") {
  try {
    systemctl(["disable", "--now", unitName], { quiet: true });
  } catch {
    // The service may not be installed or running.
  }
  if (existsSync(unitPath)) unlinkSync(unitPath);
  try {
    systemctl(["daemon-reload"], { quiet: true });
  } catch {
    // Best effort when no user systemd session exists.
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "status") {
  let state = "stopped";
  try {
    state = systemctl(["is-active", unitName]).trim();
  } catch {
    // Inactive services return non-zero.
  }
  process.stdout.write(
    `${JSON.stringify({ installed: existsSync(unitPath), loaded: state === "active", state })}\n`,
  );
} else {
  const verb = { start: "start", stop: "stop", restart: "restart" }[command];
  systemctl([verb, unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: command === "stop" ? "stopped" : "running" })}\n`);
}
