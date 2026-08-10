import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { LIVE_MODEL_METADATA_PATH } from "./paths.mjs";

export const MAX_LIVE_TOKEN_LIMIT = 100_000_000;

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function validLiveTokenLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_LIVE_TOKEN_LIMIT;
}

export function providerSourceHash(baseUrl) {
  const parsed = new URL(String(baseUrl));
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  const normalized = parsed.toString().replace(/\/$/, "");
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizedModel(model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return undefined;
  const output = { id };
  if (validLiveTokenLimit(model.maxInputTokens)) output.maxInputTokens = model.maxInputTokens;
  if (validLiveTokenLimit(model.maxOutputTokens)) output.maxOutputTokens = model.maxOutputTokens;
  return Object.keys(output).length > 1 ? output : undefined;
}

function normalizedProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const id = typeof provider.id === "string" ? provider.id.trim() : "";
  const sourceHash = typeof provider.sourceHash === "string" && /^[a-f0-9]{64}$/.test(provider.sourceHash)
    ? provider.sourceHash
    : "";
  if (!id || !sourceHash || !Array.isArray(provider.models)) return undefined;
  const models = provider.models.map(normalizedModel).filter(Boolean).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  return { id, sourceHash, models };
}

export function normalizeLiveModelMetadata(payload) {
  if (payload?.version !== 1 || !Array.isArray(payload.providers)) {
    return { version: 1, providers: [] };
  }
  const providers = payload.providers.map(normalizedProvider).filter(Boolean).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  return { version: 1, providers };
}

export function readLiveModelMetadata(target = LIVE_MODEL_METADATA_PATH) {
  if (!existsSync(target)) return { version: 1, providers: [] };
  try {
    return normalizeLiveModelMetadata(JSON.parse(readFileSync(target, "utf8")));
  } catch {
    return { version: 1, providers: [] };
  }
}

export function mergeLiveProviderMetadata(payload, freshProvider) {
  const current = normalizeLiveModelMetadata(payload);
  const fresh = normalizedProvider(freshProvider);
  if (!fresh) return { payload: current, changed: false };
  const previous = current.providers.find((provider) => provider.id === fresh.id);
  let merged = fresh;
  if (previous?.sourceHash === fresh.sourceHash) {
    const modelsById = new Map(previous.models.map((model) => [model.id, model]));
    for (const model of fresh.models) {
      modelsById.set(model.id, { ...modelsById.get(model.id), ...model });
    }
    merged = { ...fresh, models: [...modelsById.values()].sort(byId) };
  }
  const providers = current.providers.filter((provider) => provider.id !== fresh.id);
  providers.push(merged);
  providers.sort(byId);
  const next = { version: 1, providers };
  return { payload: next, changed: JSON.stringify(next) !== JSON.stringify(current) };
}

export function writeLiveModelMetadata(payload, target = LIVE_MODEL_METADATA_PATH) {
  const normalized = normalizeLiveModelMetadata(payload);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(target), 0o700);
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function applyLiveModelMetadata(models, providers, payload, sourceHashes = new Map()) {
  const normalized = normalizeLiveModelMetadata(payload);
  const liveProviders = new Map(normalized.providers.map((provider) => [provider.id, provider]));
  return models.map((model) => {
    const provider = providers.get(model.provider);
    if (provider?.importLiveModelMetadata !== true) return model;
    const liveProvider = liveProviders.get(model.provider);
    if (!liveProvider || sourceHashes.get(model.provider) !== liveProvider.sourceHash) return model;
    const live = liveProvider.models.find((candidate) => candidate.id === model.upstreamModel);
    if (!live) return model;
    const next = { ...model };
    if (validLiveTokenLimit(live.maxInputTokens)) {
      next.contextWindow = live.maxInputTokens;
      next.autoCompact = Math.max(1, Math.floor(live.maxInputTokens * 0.85));
    }
    if (validLiveTokenLimit(live.maxOutputTokens)) next.maxOutputTokens = live.maxOutputTokens;
    const fingerprint = createHash("sha256").update(JSON.stringify(live)).digest("hex").slice(0, 12);
    next.compHash = `${model.compHash || model.gatewayModel}-live-${fingerprint}`;
    return next;
  });
}
