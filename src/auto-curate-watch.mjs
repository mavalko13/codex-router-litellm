import { watch as fsWatch } from "node:fs";

export const DEFAULT_AUTO_CURATE_WATCH_DEBOUNCE_MS = 750;

export function watchedAutoCurateStateFiles({
  credentialFileName = "litellm-gateway-api-key.secret",
  endpointFileName = "provider-endpoints.json",
} = {}) {
  return new Set([credentialFileName, endpointFileName]);
}

export function isWatchedAutoCurateStateFile(filename, options) {
  if (typeof filename !== "string") return false;
  return watchedAutoCurateStateFiles(options).has(filename);
}

// Credential and endpoint writers replace their target atomically, so watch
// the containing state directory and filter events to these two exact names.
// Watching every state file would make the auto-curate overlay and its pending
// marker self-trigger a discovery/restart loop.
export function startAutoCurateStateWatcher({
  stateDir,
  credentialFileName,
  endpointFileName,
  debounceMs = DEFAULT_AUTO_CURATE_WATCH_DEBOUNCE_MS,
  watchImpl = fsWatch,
  onChange = () => {},
  onError = () => {},
} = {}) {
  let closed = false;
  let timer;
  let reportedError = false;
  const reportError = (error) => {
    if (reportedError || closed) return;
    reportedError = true;
    try {
      onError(error);
    } catch {
      // A watcher failure must never take down the running router stack.
    }
  };
  const flush = () => {
    timer = undefined;
    if (closed) return;
    try {
      onChange();
    } catch (error) {
      reportError(error);
    }
  };
  const schedule = (filename) => {
    if (
      closed ||
      !isWatchedAutoCurateStateFile(filename, { credentialFileName, endpointFileName })
    ) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  let watcher;
  try {
    watcher = watchImpl(stateDir);
    watcher?.unref?.();
    watcher?.on?.("change", (_eventType, filename) => schedule(filename));
    watcher?.on?.("error", reportError);
  } catch (error) {
    reportError(error);
  }

  return () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      watcher?.close?.();
    } catch {
      // Closing a failed filesystem watcher is best effort.
    }
  };
}
