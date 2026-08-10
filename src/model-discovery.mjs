import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, PROVIDERS } from "./model-registry.mjs";
import { credentialStatus, resolveProviderCredential } from "./provider-credentials.mjs";
import { resolveProviderBaseUrl } from "./provider-endpoints.mjs";
import {
  ensureFreshGitHubCopilotSession,
  githubCopilotCatalogHeaders,
} from "./github-copilot-session.mjs";
import { validLiveTokenLimit } from "./live-model-metadata.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function modelIds(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) throw new Error("The provider returned an invalid model list.");
  return modelIdsFromData(data, provider);
}

function modelCandidates(data, provider) {
  return provider?.authProfile === "github-copilot"
    ? data.filter((item) =>
        typeof item?.id === "string" &&
        !item.id.startsWith("accounts/") &&
        (item.object === undefined || item.object === "model") &&
        (item.capabilities?.type === undefined || item.capabilities.type === "chat") &&
        item?.policy?.state === "enabled" &&
        item?.capabilities?.supports?.tool_calls === true &&
        item?.capabilities?.supports?.streaming !== false &&
        Array.isArray(item?.supported_endpoints) &&
        item.supported_endpoints.includes("/responses")
      )
    : data;
}

function modelIdsFromData(data, provider) {
  const candidates = modelCandidates(data, provider);
  return [...new Set(candidates.map((item) => String(item?.id || "").trim()).filter(Boolean))].sort();
}

const MAX_MODELS_BODY_BYTES = 8 * 1024 * 1024;

export function modelMetadataFromPayload(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) return [];
  const grouped = new Map();
  for (const item of modelCandidates(data, provider)) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const current = grouped.get(id) || { id, input: [], output: [] };
    if (validLiveTokenLimit(item.max_input_tokens)) current.input.push(item.max_input_tokens);
    if (validLiveTokenLimit(item.max_output_tokens)) current.output.push(item.max_output_tokens);
    grouped.set(id, current);
  }
  return [...grouped.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((item) => {
    const record = { id: item.id };
    const input = [...new Set(item.input)];
    const output = [...new Set(item.output)];
    if (input.length === 1) record.maxInputTokens = input[0];
    if (output.length === 1) record.maxOutputTokens = output[0];
    return record;
  });
}

export async function boundedModelListJson(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODELS_BODY_BYTES) {
    throw new Error("Provider model discovery response is too large.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_MODELS_BODY_BYTES) {
      throw new Error("Provider model discovery response is too large.");
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MODELS_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Provider model discovery response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function providerPayload(provider, options = {}) {
  const { timeoutMs = 30_000 } = options;
  const fixture = option("--fixture");
  if (fixture) return JSON.parse(readFileSync(path.resolve(fixture), "utf8"));
  const credential = resolveProviderCredential(provider, {
    persistent: options.persistentCredential === true,
  });
  if (!credential) throw new Error(credentialStatus(provider).setup);
  let baseUrl = resolveProviderBaseUrl(provider, {
    persistent: options.persistentCredential === true,
  });
  let headers = provider.protocol === "anthropic"
    ? { "x-api-key": credential.value, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${credential.value}` };
  if (provider.authProfile === "github-copilot") {
    const session = await ensureFreshGitHubCopilotSession(credential.value);
    if (!process.env[provider.baseUrlEnv]) baseUrl = session.baseUrl;
    headers = {
      ...githubCopilotCatalogHeaders(session.token),
    };
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Provider error bodies are untrusted and sometimes contain masked key
    // identifiers, account details, or echoed request data. Discovery only
    // needs the status; never promote the upstream body into terminal/service
    // logs.
    throw new Error(`Provider model discovery returned HTTP ${response.status}.`);
  }
  try {
    return await boundedModelListJson(response);
  } catch {
    throw new Error("Provider model discovery returned an invalid model list.");
  }
}

export async function discoverProviderModels(providerId, options = {}) {
  const provider = PROVIDERS.get(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (provider.kind !== "openai-compatible") {
    throw new Error(`${provider.displayName} does not expose a supported model-list endpoint.`);
  }
  const rawPayload = await providerPayload(provider, options);
  const discovered = modelIds(rawPayload, provider);
  const metadata = modelMetadataFromPayload(rawPayload, provider);
  const registered = MODELS
    .filter((model) => model.provider === providerId)
    .map((model) => model.upstreamModel)
    .sort();
  const discoveredSet = new Set(discovered);
  const registeredSet = new Set(registered);
  return {
    provider: providerId,
    discovered,
    metadata,
    registered,
    unregistered: discovered.filter((id) => !registeredSet.has(id)),
    unavailable: registered.filter((id) => !discoveredSet.has(id)),
    note: "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex.",
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: discover-models PROVIDER [--fixture FILE] [--json]

Queries a provider's official /models endpoint and compares it with
the checked-in config/ registry tree. Credential values are never printed or written.
`);
    return;
  }
  const providerId = process.argv.slice(2).find((value) => !value.startsWith("--") && value !== option("--fixture"));
  if (!providerId) throw new Error("Pass a provider id, such as anthropic-api, deepseek, grok-api, or kimi-api.");
  const result = await discoverProviderModels(providerId);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.provider}: ${result.discovered.length} models discovered\n`);
    process.stdout.write(`Registered: ${result.registered.join(", ") || "none"}\n`);
    process.stdout.write(`New candidates: ${result.unregistered.join(", ") || "none"}\n`);
    process.stdout.write(`Unavailable registered ids: ${result.unavailable.join(", ") || "none"}\n`);
    process.stdout.write(`${result.note}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
