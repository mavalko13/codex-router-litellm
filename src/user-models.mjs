import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// User-curated models live outside the checked-in config/ registry tree so a checkout update
// never discards them. Entries carry the same shape as registry models;
// metadata uses conservative defaults the user can adjust at curation time
// (bin/curate-models asks for context, modalities, and reasoning efforts) or
// edit in place afterwards. The stored values are plain local state the user
// owns.

export const USER_MODELS_PATH =
  process.env.MODEL_ROUTER_USER_MODELS || path.join(STATE_DIR, "user-models.json");
const USER_MODELS_LOCK_TARGET = path.join(path.dirname(USER_MODELS_PATH), "user-models-transaction");

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_AUTO_COMPACT = 110000;

// Curation may adjust presentation, sizing, and effort metadata only;
// identity and routing fields always come from the provider id and the
// discovered model id.
const METADATA_FIELDS = new Set([
  "displayName",
  "description",
  "contextWindow",
  "autoCompact",
  "inputModalities",
  "reasoningLevels",
  "defaultEffort",
  "serviceTiers",
  "availabilityNux",
  "upgradeTo",
]);

function gatewaySafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export function userModelEntry({ providerId, upstreamId, requestProfile, apiSurface, priority, metadata }) {
  const gatewayModel = `${gatewaySafe(providerId)}-${gatewaySafe(upstreamId)}`;
  const entry = {
    slug: `${providerId}/${upstreamId}`,
    gatewayModel,
    upstreamModel: upstreamId,
    provider: providerId,
    listed: true,
    displayName: `${upstreamId} (curated)`,
    description: `User-curated ${providerId} model; conservative default metadata that can be edited in the user model file.`,
    priority,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    autoCompact: DEFAULT_AUTO_COMPACT,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-user-v1`,
  };
  for (const [key, value] of Object.entries(metadata || {})) {
    if (METADATA_FIELDS.has(key)) entry[key] = value;
  }
  if (requestProfile) entry.requestProfile = requestProfile;
  if (apiSurface) entry.apiSurface = apiSurface;
  return entry;
}

export function readUserModels() {
  const detail = readUserModelsDetail();
  return detail.valid ? detail.models : [];
}

// Automatic discovery must distinguish "there is no overlay yet" from "the
// operator's overlay exists but this build cannot parse it". The tolerant
// read path above keeps the router alive in both cases, while writers use this
// detail to avoid replacing a hand-edited file they do not understand.
export function readUserModelsDetail() {
  if (!existsSync(USER_MODELS_PATH)) {
    return { exists: false, valid: true, models: [] };
  }
  try {
    const payload = JSON.parse(readFileSync(USER_MODELS_PATH, "utf8"));
    if (!Array.isArray(payload?.models)) {
      return { exists: true, valid: false, models: [] };
    }
    return { exists: true, valid: true, models: payload.models };
  } catch {
    return { exists: true, valid: false, models: [] };
  }
}

function writeUserModelsUnlocked(models) {
  mkdirSync(path.dirname(USER_MODELS_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${USER_MODELS_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, USER_MODELS_PATH);
    protectPrivateFile(USER_MODELS_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return USER_MODELS_PATH;
}

export function withUserModelsLock(operation) {
  mkdirSync(path.dirname(USER_MODELS_LOCK_TARGET), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = lockfile.lockSync(USER_MODELS_LOCK_TARGET, {
      realpath: false,
      lockfilePath: `${USER_MODELS_LOCK_TARGET}.lock`,
      stale: 90_000,
      update: 10_000,
      retries: 0,
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      throw new Error("Another user-model update is still running; retry shortly.", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    release();
  }
}

export function updateUserModels(operation) {
  return withUserModelsLock(() => {
    const result = operation(readUserModelsDetail());
    if (Array.isArray(result?.models)) writeUserModelsUnlocked(result.models);
    return result?.value;
  });
}

export function writeUserModels(models) {
  return withUserModelsLock(() => writeUserModelsUnlocked(models));
}
