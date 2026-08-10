import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { protectPrivateFile } from "./file-security.mjs";
import { PROVIDER_ENDPOINTS_PATH, STATE_DIR } from "./paths.mjs";

function normalizedHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("The provider endpoint cannot be empty.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The provider endpoint must be a valid HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("The provider endpoint must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not put credentials in the provider endpoint URL.");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateProviderEndpoint(value) {
  return normalizedHttpUrl(value);
}

export function readProviderEndpoints() {
  if (!existsSync(PROVIDER_ENDPOINTS_PATH)) return {};
  try {
    const payload = JSON.parse(readFileSync(PROVIDER_ENDPOINTS_PATH, "utf8"));
    if (payload?.version !== 1 || !payload.endpoints || typeof payload.endpoints !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(payload.endpoints).flatMap(([id, value]) => {
        try {
          return [[id, normalizedHttpUrl(value)]];
        } catch {
          return [];
        }
      }),
    );
  } catch {
    return {};
  }
}

function writeProviderEndpoints(endpoints) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const temporary = `${PROVIDER_ENDPOINTS_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, endpoints }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, PROVIDER_ENDPOINTS_PATH);
    protectPrivateFile(PROVIDER_ENDPOINTS_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function providerEndpointStatus(provider, options = {}) {
  if (!provider || provider.kind !== "openai-compatible") {
    throw new Error("Only OpenAI-compatible providers have an upstream endpoint.");
  }
  if (!options.persistent) {
    const environment = process.env[provider.baseUrlEnv]?.trim();
    if (environment) {
      return { value: normalizedHttpUrl(environment), source: `environment (${provider.baseUrlEnv})`, persistent: false };
    }
  }
  const stored = readProviderEndpoints()[provider.id];
  if (stored) {
    return { value: stored, source: `protected local settings (${PROVIDER_ENDPOINTS_PATH})`, persistent: true };
  }
  return { value: normalizedHttpUrl(provider.baseUrl), source: "provider default", persistent: true };
}

export function resolveProviderBaseUrl(provider, options = {}) {
  return providerEndpointStatus(provider, options).value;
}

export function writeProviderEndpoint(provider, value) {
  if (!provider?.configurableBaseUrl) {
    throw new Error(`Provider ${provider?.id || "unknown"} does not support a saved custom endpoint.`);
  }
  const endpoint = normalizedHttpUrl(value);
  const endpoints = readProviderEndpoints();
  endpoints[provider.id] = endpoint;
  writeProviderEndpoints(endpoints);
  return endpoint;
}

export function removeProviderEndpoint(provider) {
  if (!provider?.configurableBaseUrl) {
    throw new Error(`Provider ${provider?.id || "unknown"} does not support a saved custom endpoint.`);
  }
  const endpoints = readProviderEndpoints();
  if (!Object.hasOwn(endpoints, provider.id)) return false;
  delete endpoints[provider.id];
  writeProviderEndpoints(endpoints);
  return true;
}
