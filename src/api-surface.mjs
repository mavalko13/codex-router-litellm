export const API_SURFACE_RESPONSES = "responses";
export const API_SURFACE_CHAT_COMPLETIONS = "chat-completions";
export const API_SURFACE_MESSAGES = "messages";

export const DECLARED_API_SURFACES = Object.freeze([
  API_SURFACE_RESPONSES,
  API_SURFACE_CHAT_COMPLETIONS,
]);

export function isAutoCuratedModel(model) {
  if (model?.autoCurated === true) return true;
  return /\(auto-curated\)\s*$/i.test(String(model?.displayName || "")) ||
    /^Auto-curated from the live /i.test(String(model?.description || ""));
}

function providerOverrides(provider) {
  return Array.isArray(provider?.apiSurfaceOverrides)
    ? provider.apiSurfaceOverrides
    : [];
}

export function providerUsesMixedApiSurfaces(provider) {
  return providerOverrides(provider).length > 0;
}

// Overrides are literal provider-owned prefixes, never regular expressions.
// Longest-prefix selection makes overlapping rules deterministic and prevents
// a broad entry from shadowing a more specific one because of array order.
export function trustedApiSurfaceForUpstream(provider, upstreamModel) {
  const upstream = String(upstreamModel || "");
  const matches = providerOverrides(provider)
    .filter(({ prefix }) => upstream.startsWith(prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  return matches[0]?.apiSurface ?? provider?.defaultApiSurface;
}

export function inferredTrustedApiSurface(model, provider) {
  if (!isAutoCuratedModel(model)) return undefined;
  return trustedApiSurfaceForUpstream(provider, model?.upstreamModel);
}

export function effectiveApiSurface(model, provider) {
  if (provider?.protocol === "anthropic") return API_SURFACE_MESSAGES;
  if (DECLARED_API_SURFACES.includes(model?.apiSurface)) return model.apiSurface;

  const providerSurface = trustedApiSurfaceForUpstream(provider, model?.upstreamModel);
  if (providerSurface) return providerSurface;
  if (provider?.protocol === "openai-responses") return API_SURFACE_RESPONSES;
  return API_SURFACE_CHAT_COMPLETIONS;
}

export function apiRouteForSurface(surface) {
  if (surface === API_SURFACE_RESPONSES) return "/responses";
  if (surface === API_SURFACE_MESSAGES) return "/messages";
  if (surface === API_SURFACE_CHAT_COMPLETIONS) return "/chat/completions";
  return undefined;
}
