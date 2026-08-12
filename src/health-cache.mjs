// The companion polls the router's /health continuously, and every one of
// those fanned out to three downstream probes -- including the gateway's
// /health/liveliness, which LiteLLM's uvicorn logs a line for. On an idle
// machine that measured 2.5 probes a second, roughly 16.6 MB of log a day,
// none of it carrying information: the answer cannot meaningfully change
// between two probes a fraction of a second apart.
//
// A short TTL collapses a burst of polls into one probe. It is deliberately
// short: clients show live service status, so a stale "reachable" is a lie
// with a shelf life, and a few seconds is the most that is honest.
export const DEFAULT_HEALTH_TTL_MS = 3_000;

export function createHealthCache({
  ttlMs = DEFAULT_HEALTH_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  return function cachedProbe(key, probe) {
    const existing = entries.get(key);
    // Concurrent callers share the in-flight promise rather than each starting
    // their own probe, so a burst of polls costs one request, not one each.
    if (existing && now() - existing.at < ttlMs) return existing.promise;

    const promise = Promise.resolve()
      .then(probe)
      .catch((error) => {
        // A thrown probe must not be cached as an answer: drop it so the next
        // caller retries instead of inheriting the failure for the whole TTL.
        entries.delete(key);
        throw error;
      });
    entries.set(key, { at: now(), promise });
    return promise;
  };
}
