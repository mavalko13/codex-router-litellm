import { discoverProviderModels } from "./model-discovery.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markAutoCurateRefreshPending } from "./auto-curate-state.mjs";
import {
  effectiveApiSurface,
  inferredTrustedApiSurface,
} from "./api-surface.mjs";
import { MODELS, PROVIDERS } from "./model-registry.mjs";
import {
  configuredProviderIds,
  readProviderSelection,
} from "./provider-selection.mjs";
import {
  readUserModelsDetail,
  updateUserModels,
  userModelEntry,
} from "./user-models.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import {
  mergeLiveProviderMetadata,
  providerSourceHash,
  readLiveModelMetadata,
  writeLiveModelMetadata,
} from "./live-model-metadata.mjs";
import { resolveProviderBaseUrl } from "./provider-endpoints.mjs";

const AUTO_DISCOVERY_TIMEOUT_MS = 10_000;

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function autoMetadata(provider, upstreamId) {
  return {
    displayName: `${upstreamId} (auto-curated)`,
    description:
      `Auto-curated from the live ${provider.displayName} model catalog. ` +
      "Capabilities use conservative local defaults until the operator verifies and edits them.",
  };
}

export function migrateLegacyApiSurfaces(models, providers) {
  const migrated = [];
  const output = models.map((model) => {
    if (model?.apiSurface !== undefined) return model;
    const provider = providers.get(model?.provider);
    const apiSurface = inferredTrustedApiSurface(model, provider);
    if (!apiSurface) return model;
    migrated.push(String(model.upstreamModel));
    // Add only the routing discriminator. Every operator-edited presentation,
    // capability and priority field remains byte-for-byte equivalent in JSON.
    return { ...model, apiSurface };
  });
  return { models: output, migrated };
}

export function planAutoCuratedModels({
  provider,
  discovered,
  registryModels,
  userModels,
}) {
  const combined = [...registryModels, ...userModels];
  const knownUpstream = new Set(
    combined
      .filter((model) => model.provider === provider.id)
      .map((model) => String(model.upstreamModel)),
  );
  const knownSlugs = new Set(combined.map((model) => String(model.slug)));
  const knownGatewayModels = new Set(combined.map((model) => String(model.gatewayModel)));
  const requestProfile = registryModels.find(
    (model) => model.provider === provider.id && model.requestProfile,
  )?.requestProfile;
  let priority = Math.max(
    99,
    ...userModels
      .filter((model) => model.provider === provider.id && Number.isInteger(model.priority))
      .map((model) => model.priority),
  );
  const additions = [];
  const skipped = [];
  for (const upstreamId of uniqueSorted(discovered)) {
    if (knownUpstream.has(upstreamId)) {
      skipped.push(upstreamId);
      continue;
    }
    const apiSurface = effectiveApiSurface(
      { upstreamModel: upstreamId, autoCurated: true },
      provider,
    );
    // A trusted gateway can declare a conservative default plus literal
    // provider-scoped overrides. Providers without either retain the router's
    // normal Chat Completions default.
    const isListed = apiSurface !== undefined;
    const entry = {
      ...userModelEntry({
        providerId: provider.id,
        upstreamId,
        requestProfile,
        apiSurface,
        priority: ++priority,
        metadata: autoMetadata(provider, upstreamId),
      }),
      listed: isListed,
      autoCurated: true,
      // apply_patch is a model capability, not a generic OpenAI-compatible
      // promise. Auto-discovery has not tested it, so fail closed.
      supportsApplyPatchTool: false,
    };
    if (knownSlugs.has(entry.slug) || knownGatewayModels.has(entry.gatewayModel)) {
      skipped.push(upstreamId);
      continue;
    }
    additions.push(entry);
    knownUpstream.add(upstreamId);
    knownSlugs.add(entry.slug);
    knownGatewayModels.add(entry.gatewayModel);
  }
  return { additions, skipped };
}

function logIds(log, prefix, ids) {
  if (ids.length > 0) log(`${prefix}: ${ids.map((id) => JSON.stringify(id)).join(", ")}`);
}

// This path is deliberately additive. A provider omitting a model may be a
// transient ACL or network condition, so discovery records the miss and keeps
// the local entry until the operator explicitly prunes it with curate-models.
export async function autoCurateDiscoveredModels({
  providers = PROVIDERS,
  registryModels = MODELS,
  discover = (providerId) =>
    discoverProviderModels(providerId, {
      timeoutMs: AUTO_DISCOVERY_TIMEOUT_MS,
      persistentCredential: true,
    }),
  configured = configuredProviderIds,
  selected = readProviderSelection,
  read = readUserModelsDetail,
  update = updateUserModels,
  readLiveMetadata = readLiveModelMetadata,
  writeLiveMetadata = writeLiveModelMetadata,
  providerBaseUrl = (provider) => resolveProviderBaseUrl(provider, { persistent: true }),
  markPending = markAutoCurateRefreshPending,
  assertOwner = assertStateOwnership,
  log = (message) => console.error(`[codex-router] ${message}`),
} = {}) {
  const initial = read();
  if (!initial.valid) {
    log("auto-curation skipped because user-models.json is unreadable; preserving the existing file");
    return {
      added: 0,
      providers: [],
      failures: [{ reason: "user-models-invalid" }],
    };
  }

  const selectedIds = new Set(selected());
  const configuredIds = new Set(configured());
  const eligible = [...providers.values()].filter(
    (provider) =>
      (provider.autoCurateDiscoveredModels === true || provider.importLiveModelMetadata === true) &&
      selectedIds.has(provider.id) &&
      configuredIds.has(provider.id),
  );
  const planned = [];
  const metadataUpdates = [];
  const summaries = [];
  const failures = [];
  const initialMigration = migrateLegacyApiSurfaces(initial.models, providers);
  let workingUserModels = initialMigration.models;

  for (const provider of eligible) {
    let discovery;
    try {
      discovery = await discover(provider.id);
    } catch {
      log(`auto-curation failed for provider ${provider.id}; keeping the existing catalog`);
      failures.push({ provider: provider.id, reason: "discovery-failed" });
      continue;
    }
    const plan = provider.autoCurateDiscoveredModels === true
      ? planAutoCuratedModels({
          provider,
          discovered: discovery.discovered,
          registryModels,
          userModels: workingUserModels,
        })
      : { additions: [], skipped: [] };
    planned.push(...plan.additions);
    workingUserModels.push(...plan.additions);
    if (provider.importLiveModelMetadata === true) {
      try {
        metadataUpdates.push({
          id: provider.id,
          sourceHash: providerSourceHash(providerBaseUrl(provider)),
          models: discovery.metadata || [],
        });
      } catch {
        log(`live metadata skipped for provider ${provider.id}; keeping the existing metadata cache`);
        failures.push({ provider: provider.id, reason: "metadata-source-invalid" });
      }
    }
    const stale = uniqueSorted(discovery.unavailable);
    summaries.push({
      provider: provider.id,
      planned: plan.additions.length,
      skipped: plan.skipped,
      stale,
    });
    logIds(log, `skipped already-known or colliding ids for provider ${provider.id}`, plan.skipped);
    logIds(log, `provider ${provider.id} no longer advertises locally preserved ids`, stale);
  }

  if (
    planned.length === 0 &&
    initialMigration.migrated.length === 0 &&
    metadataUpdates.length === 0
  ) {
    for (const summary of summaries) {
      log(`auto-curated 0 models for provider ${summary.provider}`);
    }
    return { added: 0, providers: summaries, failures };
  }

  // Re-read immediately before the atomic write. If manual curation changed
  // the file while discovery was in flight, merge into that newer valid state
  // rather than replacing the operator's edits with the earlier snapshot.
  // This writer mutates managed state just like the catalog and LiteLLM
  // renderers. A checkout that does not own the state directory may discover
  // models, but it must not commit an overlay or its restart marker.
  assertOwner("write auto-curated model state");
  const transaction = update((latest) => {
    if (!latest.valid) return { value: { invalid: true, appended: [] } };
    const migration = migrateLegacyApiSurfaces(latest.models, providers);
    const slugs = new Set(migration.models.map((model) => String(model.slug)));
    const gateways = new Set(migration.models.map((model) => String(model.gatewayModel)));
    const upstream = new Set(
      migration.models.map((model) => `${model.provider}\u0000${model.upstreamModel}`),
    );
    const appended = [];
    for (const entry of planned) {
      const upstreamKey = `${entry.provider}\u0000${entry.upstreamModel}`;
      if (slugs.has(entry.slug) || gateways.has(entry.gatewayModel) || upstream.has(upstreamKey)) {
        continue;
      }
      appended.push(entry);
      slugs.add(entry.slug);
      gateways.add(entry.gatewayModel);
      upstream.add(upstreamKey);
    }
    let livePayload = readLiveMetadata();
    let metadataChanged = false;
    for (const metadataUpdate of metadataUpdates) {
      const mergedMetadata = mergeLiveProviderMetadata(livePayload, metadataUpdate);
      livePayload = mergedMetadata.payload;
      metadataChanged ||= mergedMetadata.changed;
    }
    if (appended.length === 0 && migration.migrated.length === 0 && !metadataChanged) {
      return { value: { invalid: false, appended, migrated: [], metadataChanged: false } };
    }
    // The durable marker is committed before the overlay while both are under
    // the shared user-model transaction. A crash can therefore cause a
    // harmless extra rebuild, never a permanently unpublished model.
    markPending();
    if (metadataChanged) writeLiveMetadata(livePayload);
    return {
      models: [...migration.models, ...appended],
      value: {
        invalid: false,
        appended,
        migrated: migration.migrated,
        metadataChanged,
      },
    };
  });
  const appended = transaction.appended;
  if (transaction.invalid) {
    log("auto-curation write skipped because user-models.json became unreadable; preserving it");
    failures.push({ reason: "user-models-became-invalid" });
    return { added: 0, providers: summaries, failures };
  }

  logIds(log, "migrated legacy apiSurface ids", transaction.migrated || []);

  for (const summary of summaries) {
    const addedIds = appended
      .filter((model) => model.provider === summary.provider)
      .map((model) => model.upstreamModel);
    summary.added = addedIds.length;
    log(`auto-curated ${addedIds.length} models for provider ${summary.provider}`);
    logIds(log, `auto-curated ids for provider ${summary.provider}`, addedIds);
  }
  return {
    added: appended.length,
    migrated: (transaction.migrated || []).length,
    metadataChanged: transaction.metadataChanged === true,
    providers: summaries,
    failures,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await autoCurateDiscoveredModels();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Keep the CLI failure generic: discovery error bodies are not a safe log
    // surface and the caller only needs the non-zero status.
    console.error("[codex-router] automatic model curation failed; existing state was preserved");
    process.exitCode = 1;
  }
}
