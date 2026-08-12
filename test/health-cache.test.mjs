import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_HEALTH_TTL_MS, createHealthCache } from "../src/health-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The clock is injected so these assert the caching rule itself rather than
// waiting real seconds for a TTL to lapse.
function fixedClock(start = 0) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

test("a burst of polls inside the window costs one probe", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => {
    probes += 1;
    return { reachable: true };
  };

  const results = await Promise.all([
    cached("gateway", probe),
    cached("gateway", probe),
    cached("gateway", probe),
  ]);
  // This is the whole point: the companion polls continuously and every poll
  // used to reach the gateway, whose access log was the bulk of a 191 MB file.
  assert.equal(probes, 1);
  for (const result of results) assert.deepEqual(result, { reachable: true });
});

test("the answer is refreshed once the window lapses", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => ({ reachable: (probes += 1) === 1 });

  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  clock.t = 2_999;
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  // A service that goes down must not stay "reachable" indefinitely; the TTL
  // is the entire bound on how stale a client status can be.
  clock.t = 3_000;
  assert.deepEqual(await cached("gateway", probe), { reachable: false });
  assert.equal(probes, 2);
});

test("services are cached independently", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  const seen = [];
  const probe = (name) => () => {
    seen.push(name);
    return { reachable: true };
  };

  await Promise.all([
    cached("gateway", probe("gateway")),
    cached("api", probe("api")),
    cached("oauth", probe("oauth")),
  ]);
  // One shared key would have let the gateway's answer stand in for the API
  // forwarder's, reporting a dead service as healthy.
  assert.deepEqual(seen.sort(), ["api", "gateway", "oauth"]);
});

test("a thrown probe is not cached as an answer", async () => {
  const clock = fixedClock();
  const cached = createHealthCache({ ttlMs: 3_000, now: clock.now });
  let probes = 0;
  const probe = () => {
    probes += 1;
    if (probes === 1) throw new Error("connection refused");
    return { reachable: true };
  };

  await assert.rejects(() => cached("gateway", probe), /connection refused/);
  // Still inside the window: a cached rejection would keep the service marked
  // broken for the full TTL even though the next probe would have succeeded.
  assert.deepEqual(await cached("gateway", probe), { reachable: true });
  assert.equal(probes, 2);
});

test("the default window is short enough for a live status display", () => {
  // Clients present this as current service state. A long TTL turns it into
  // a stale claim, so the default is capped at a few seconds by intent.
  assert.ok(DEFAULT_HEALTH_TTL_MS > 0);
  assert.ok(DEFAULT_HEALTH_TTL_MS <= 5_000);
});

test("the router probes through the cache, not around it", () => {
  const router = readFileSync(path.join(root, "src", "router.mjs"), "utf8");
  // healthPayload calls serviceHealth three times per request; if that ever
  // goes straight to the network again the probe flood comes back silently.
  assert.match(router, /const healthCache = createHealthCache\(\)/);
  assert.match(router, /function serviceHealth\(url\)\s*\{\s*return healthCache\(url,/);
});
