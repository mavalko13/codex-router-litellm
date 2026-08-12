import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { protectPrivateFile } from "./file-security.mjs";
import { RETIRED_ROUTED_MODELS_PATH } from "./paths.mjs";

const LOCK_TARGET = path.join(
  path.dirname(RETIRED_ROUTED_MODELS_PATH),
  "retired-routed-models-transaction",
);

function validSlug(value) {
  return (
    typeof value === "string" &&
    /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value)
  );
}

function normalizedEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.provider !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.provider)) {
    return undefined;
  }
  if (
    !Array.isArray(value.successors) ||
    value.successors.some((successor) => !validSlug(successor))
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    successors: [...new Set(value.successors)],
    ...(typeof value.retiredAt === "string" ? { retiredAt: value.retiredAt } : {}),
  };
}

export function readRetiredRoutedModels() {
  if (!existsSync(RETIRED_ROUTED_MODELS_PATH)) {
    return { exists: false, valid: true, models: {}, active: {} };
  }
  try {
    const payload = JSON.parse(readFileSync(RETIRED_ROUTED_MODELS_PATH, "utf8"));
    if (
      payload?.version !== 1 ||
      !payload.models ||
      typeof payload.models !== "object" ||
      Array.isArray(payload.models) ||
      !payload.active ||
      typeof payload.active !== "object" ||
      Array.isArray(payload.active)
    ) {
      return { exists: true, valid: false, models: {}, active: {} };
    }
    const models = {};
    const active = {};
    for (const [slug, value] of Object.entries(payload.models)) {
      const entry = normalizedEntry(value);
      if (!validSlug(slug) || !entry) {
        return { exists: true, valid: false, models: {}, active: {} };
      }
      models[slug] = entry;
    }
    for (const [slug, value] of Object.entries(payload.active)) {
      const entry = normalizedEntry(value);
      if (!validSlug(slug) || !entry) {
        return { exists: true, valid: false, models: {}, active: {} };
      }
      active[slug] = entry;
    }
    return { exists: true, valid: true, models, active };
  } catch {
    return { exists: true, valid: false, models: {}, active: {} };
  }
}

function writeStateUnlocked(value) {
  mkdirSync(path.dirname(RETIRED_ROUTED_MODELS_PATH), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${RETIRED_ROUTED_MODELS_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, RETIRED_ROUTED_MODELS_PATH);
    protectPrivateFile(RETIRED_ROUTED_MODELS_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function updateState(operation) {
  mkdirSync(path.dirname(LOCK_TARGET), { recursive: true, mode: 0o700 });
  const release = lockfile.lockSync(LOCK_TARGET, {
    realpath: false,
    lockfilePath: `${LOCK_TARGET}.lock`,
    stale: 90_000,
    update: 10_000,
    retries: 0,
  });
  try {
    const current = readRetiredRoutedModels();
    // A state file the running build cannot understand is operator-owned
    // evidence. Never replace it with an empty interpretation.
    if (!current.valid) return { written: false, reason: "invalid-state" };
    const next = operation(current);
    writeStateUnlocked({ version: 1, models: next.models, active: next.active });
    return { written: true };
  } finally {
    release();
  }
}

function stateEntry(model, retiredAt) {
  const successors = validSlug(model?.upgradeTo?.model)
    ? [model.upgradeTo.model]
    : [];
  return {
    provider: model.provider,
    successors,
    ...(retiredAt ? { retiredAt } : {}),
  };
}

// Catalog refreshes retain a compact tombstone for every routed slug that
// disappeared from the complete registry. The successor is copied only from
// the registry's explicit upgradeTo contract; absence stays null rather than
// becoming a same-provider or similarly-named guess.
export function reconcileRetiredRoutedModels(models, now = new Date().toISOString()) {
  const currentModels = new Map(
    models
      .filter((model) => validSlug(model?.slug) && typeof model?.provider === "string")
      .map((model) => [model.slug, model]),
  );
  return updateState((state) => {
    const retired = { ...state.models };
    for (const [slug, previous] of Object.entries(state.active)) {
      if (!currentModels.has(slug)) {
        retired[slug] = { ...previous, retiredAt: previous.retiredAt || now };
      }
    }
    for (const slug of currentModels.keys()) delete retired[slug];
    return {
      models: Object.fromEntries(Object.entries(retired).sort()),
      active: Object.fromEntries(
        [...currentModels]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([slug, model]) => [slug, stateEntry(model)]),
      ),
    };
  });
}

// Auto-curation removes the model overlay before the next process imports the
// registry. Record those exact objects first so their explicit successor
// contract cannot disappear together with them.
export function recordRetiredRoutedModels(models, now = new Date().toISOString()) {
  const entries = models.filter(
    (model) => validSlug(model?.slug) && typeof model?.provider === "string",
  );
  if (entries.length === 0) return { written: false, reason: "empty" };
  return updateState((state) => {
    const retired = { ...state.models };
    const active = { ...state.active };
    for (const model of entries) {
      retired[model.slug] = stateEntry(model, now);
      delete active[model.slug];
    }
    return {
      models: Object.fromEntries(Object.entries(retired).sort()),
      active: Object.fromEntries(Object.entries(active).sort()),
    };
  });
}
