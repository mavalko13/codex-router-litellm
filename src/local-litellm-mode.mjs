import { MODELS, PROVIDERS } from "./model-registry.mjs";
import { readProviderSelection } from "./provider-selection.mjs";

export function providerCanBypassLocalLiteLlm(providerOrId, providers = PROVIDERS) {
  const provider =
    providerOrId && typeof providerOrId === "object"
      ? providerOrId
      : providers.get(String(providerOrId || ""));
  return Boolean(provider?.directResponses);
}

export function modelCanBypassLocalLiteLlm(model, provider = PROVIDERS.get(model?.provider)) {
  return Boolean(
    model &&
      provider &&
      provider.kind === "openai-compatible" &&
      !provider.keyless &&
      providerCanBypassLocalLiteLlm(provider),
  );
}

export function localLiteLlmRequiredForProviderIds(providerIds, providers = PROVIDERS) {
  const ids = [...new Set((providerIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) return true;
  return ids.some((id) => !providerCanBypassLocalLiteLlm(id, providers));
}

export function localLiteLlmRequiredForSelection({
  providerIds = readProviderSelection(),
  models = MODELS,
  providers = PROVIDERS,
} = {}) {
  const selected = [...new Set((providerIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (localLiteLlmRequiredForProviderIds(selected, providers)) return true;

  const selectedSet = new Set(selected);
  const selectedModels = (models || []).filter(
    (model) => model?.listed && selectedSet.has(model.provider),
  );
  // With only a direct-forward provider selected, an empty picker has no
  // request path to serve. Do not make first-time configuration require a
  // local Python/LiteLLM installation before the user curates a model.
  if (selectedModels.length === 0) return false;
  return selectedModels.some((model) => !modelCanBypassLocalLiteLlm(model, providers.get(model.provider)));
}

export function localLiteLlmModeStatus(options = {}) {
  const required = localLiteLlmRequiredForSelection(options);
  return {
    required,
    mode: required ? "local-litellm" : "direct-forward",
  };
}

export function localLiteLlmRequiredText(options = {}) {
  return localLiteLlmRequiredForSelection(options) ? "required" : "not-required";
}
