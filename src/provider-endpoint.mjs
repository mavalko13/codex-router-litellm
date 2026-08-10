import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

import { PROVIDERS } from "./model-registry.mjs";
import {
  providerEndpointStatus,
  removeProviderEndpoint,
  validateProviderEndpoint,
  writeProviderEndpoint,
} from "./provider-endpoints.mjs";
import {
  powerShellStartupError,
  WINDOWS_POWERSHELL_CANDIDATES,
} from "./windows-powershell.mjs";

function visiblePrompt(label, defaultValue) {
  if (process.platform === "win32") {
    const script = "$answer = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL; [Console]::Out.Write($answer)";
    const failures = [];
    for (const executable of WINDOWS_POWERSHELL_CANDIDATES) {
      try {
        const answer = execFileSync(executable, ["-NoLogo", "-NoProfile", "-Command", script], {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: `${label} [${defaultValue}]` },
          stdio: ["inherit", "pipe", "inherit"],
        }).trim();
        return answer || defaultValue;
      } catch (error) {
        failures.push(error);
      }
    }
    throw powerShellStartupError(failures, "PowerShell is required for interactive endpoint setup.");
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("An interactive terminal is required; alternatively pass the endpoint URL after `set`.");
  }
  try {
    writeSync(descriptor, `${label} [${defaultValue}]: `);
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    return Buffer.concat(chunks).toString("utf8").trim() || defaultValue;
  } finally {
    closeSync(descriptor);
  }
}

const providerId = process.argv[2];
const command = process.argv[3] || "status";
const provider = PROVIDERS.get(providerId || "");

if (!provider || !provider.configurableBaseUrl || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-endpoint.mjs PROVIDER status|set [HTTP(S)-URL]|remove");
  process.exit(2);
}

if (command === "status") {
  const status = providerEndpointStatus(provider);
  process.stdout.write(`${provider.displayName} endpoint: ${status.value} (${status.source}).\n`);
  if (!status.persistent) {
    process.stdout.write("This environment-only endpoint is not inherited by the background service; run the set command to save it.\n");
  }
} else if (command === "set") {
  const current = providerEndpointStatus(provider, { persistent: true }).value;
  const raw = process.argv[4] || visiblePrompt(`${provider.displayName} OpenAI-compatible base URL`, current);
  const endpoint = writeProviderEndpoint(provider, validateProviderEndpoint(raw));
  process.stdout.write(`${provider.displayName} endpoint saved in protected local settings: ${endpoint}\n`);
} else {
  const removed = removeProviderEndpoint(provider);
  const fallback = providerEndpointStatus(provider, { persistent: true }).value;
  process.stdout.write(
    removed
      ? `Removed the saved ${provider.displayName} endpoint; default is now ${fallback}.\n`
      : `No saved ${provider.displayName} endpoint exists; default is ${fallback}.\n`,
  );
}
