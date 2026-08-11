# Development guide

## Architecture

- `config/` is the split provider and model registry tree.
- `src/model-registry.mjs` validates and indexes that registry.
- `src/catalog.mjs` merges listed registry models with native Codex models.
- `src/litellm-config.mjs` generates every provider translation route.
- `src/router.mjs` dispatches native and namespaced external model IDs.
- `src/oauth-forwarder.mjs` owns Kimi CLI OAuth loading and refresh.
- `src/grok-oauth-forwarder.mjs` adapts Grok CLI OAuth to OpenAI-compatible chat.
- `src/api-forwarder.mjs` is shared by all API-key providers.
- `src/provider-credentials.mjs` isolates environment, file, and Keychain lookup.
- `src/rate-limit-headers.mjs` parses provider rate-limit headers into snapshots.
- `src/rate-limit-state.mjs` stores the latest observed window per provider.
- `src/provider-selection.mjs` controls which tested models enter the picker.
- `src/start.mjs` supervises the loopback processes.
- `src/service-*.mjs` install per-user services for macOS, Linux, and Windows.
- `src/paths.mjs` defines state roots, ports, and service names.

## Add an API-key provider

1. Add a provider fragment under `config/<vendor>/` with a unique lowercase ID,
   API base URL, protocol when it is not OpenAI-compatible, environment variable, protected key filename, and optional
   Keychain service.
2. Add one model object per upstream model. Public slugs should be namespaced as
   `provider/model`, and internal `gatewayModel` values must be unique.
3. Supply picker metadata for listed models: label, description, reasoning
   levels, context window, compaction limit, modalities, and compatibility hash.
4. Use an existing request profile or add a narrowly scoped profile to
   `src/api-forwarder.mjs` when the upstream needs parameter normalization.
5. Add routing, credential-isolation, and request-normalization tests.
6. Run `bin/discover-models PROVIDER` against the official model endpoint.
7. Install in isolated state and run
   `bin/test-model provider/model --live --yes`; verify text, streaming, tool
   calls, and compaction before setting `listed: true`.
8. Update the README model table and provider-specific setup documentation.

The shared API forwarder strips host and internal authentication before
injecting the selected provider key. It supports the registry's tested
OpenAI-compatible and Anthropic protocols; do not create a new listener merely
to add another provider using one of those protocols.

OAuth schemes usually need a dedicated adapter because refresh and identity
rules are provider-specific. Never infer that an API key can replace an OAuth
credential or vice versa.

GitHub Copilot is the existing dynamic-auth exception inside the shared API
forwarder. Its registry provider declares `authProfile: "github-copilot"`;
`src/github-copilot-session.mjs` validates the stored fine-grained PAT against
the account endpoint, caches the validated account routing briefly, allowlists
the returned inference host, and builds provider identity headers. Do not reuse
that profile for another vendor.

## Registry rules

The registry is intentionally declarative. `src/model-registry.mjs` rejects
unknown provider kinds, duplicate provider IDs, duplicate public slugs,
duplicate gateway model IDs, missing credential metadata, and incomplete picker
metadata.

Models may declare `serviceTiers` as `{ id, name, description? }` entries only
when the upstream is verified to honor those request values. The catalog
exposes them as opt-in choices and always keeps standard service as the
default. User-curated entries can add the same field directly in
`user-models.json`; duplicate tier IDs are rejected.

Set `listed: false` for compatibility aliases that must remain routable but
should not appear in the app picker. Every model, listed or hidden, receives a
generated LiteLLM route.

An alternate registry can be tested in a development process with
`CODEX_ROUTER_REGISTRY=/path/file.json`. Installed background services use the
checked-in registry.

User-curated models (`user-models.json` in the state directory, written by
`bin/curate-models`) overlay the checked-in registry at load time. They pass
the same per-model validation, but a problem — including a collision with a
model a registry update later ships — skips the entry and surfaces it in
`USER_MODEL_WARNINGS` instead of failing the load, so a stale user file can
never take the router down. The listed-model live-test requirement applies to
registry submissions; curated entries are explicitly local-only.

Curated entries get their metadata from the user, not from any online
catalog: interactive curation asks for each new model's context window,
image support, and reasoning efforts (`--efforts` sets the effort ladder in
the deterministic `--models` form), and everything defaults conservatively
when unanswered. The stored entries in `user-models.json` are plain local
state — edit any value in place and re-run `./bin/install` to apply.

Providers may set `autoCurateDiscoveredModels: true` only when their live
catalog and persistent credential are trusted for unattended local use. The
portable registry enables this for the operator-owned `litellm-gateway`, not
for arbitrary reseller catalogs. It also declares `defaultApiSurface` and may
declare validated prefix overrides. The generic LiteLLM default is
`chat-completions`; operators can set `--api-surface responses` or
`--api-surface chat-completions` per model. Never infer a wire API from a model
name globally.

Automatic curation is conservative. A successfully parsed snapshot for an
opted-in trusted provider reconciles only its `autoCurated: true` overlay
entries; existing manual and checked-in registry entries remain untouched.
Discovery failure preserves the last usable catalog. Publication writes gateway
routes before the picker catalog. A durable pending marker survives
interruption, and the supervisor performs one coordinated local stack restart
when publication is needed. While it is running, it watches only that
provider's saved credential and endpoint files for a debounced immediate
discovery; it never watches generated catalog/overlay state, avoiding a
self-triggered loop. Codex Desktop itself must be fully restarted to reread
the picker.

The deterministic `--models` form is additive so adding one model cannot
discard other curated entries or their hand-tuned metadata. Non-interactive
pruning is explicit with `--remove id1,id2` and does not require a provider
network request. The interactive picker remains authoritative: deselecting an
entry there removes it.

A curated model inherits a request profile from the provider's registry
models when it has any. The catalog-only resellers ship none, so curation
also offers `auto-tool-choice` (`--request-profile` in the deterministic
form) — the one profile meaningful to pick by hand, for a model whose
upstream rejects `tool_choice: "required"` while still calling tools under
`"auto"`. It normalizes the tool choice and nothing else, so it composes with
no vendor's parameter surface and misreads none. Keep it per model: the
restriction belongs to the upstream behind the reseller, and a provider-wide
downgrade would let models that honor a forced choice decline both the
compatibility probe and the subagent payload relay's forced function call.

## Tests

```sh
npm run verify:local
```

This is the local core gate: clean root dependency installation, JavaScript
syntax, the full Node suite, production dependency audit, and entrypoint checks
for the current platform. It does not call provider APIs or paid models.

After changing `apps/desktop`, run `npm run verify:local:full`. It also installs
the desktop lock, runs the Rust/Tauri checks, and builds the native binary;
`cargo` and `rustc` are required. `npm run verify:local:fast` skips only
dependency installation on a repeat run, while `npm run verify:local:plan`
prints the full plan without executing it.

The test suite verifies native header forwarding, external credential
isolation, Kimi and DeepSeek rewriting, registry-generated gateway routes,
Zstandard request decoding, both Codex compaction formats, legacy migration,
provider selection, port defaults, Anthropic API forwarding, discovery
comparison, and service rendering for all three service platforms.

GitHub is deliberately a small integration gate. PRs into `beta` and `main`
run only the short Windows service/installer regression set, including
PowerShell parsing. The Python-lock workflow is manual-only because it is a
four-platform package-install matrix; run it deliberately when changing the
Python lock or installer. CodeQL stays automatic for `main`, pull requests,
and its weekly scan.

The normal flow is `codex/<feature>` to a PR into `beta`, then a separate PR
from `beta` to `main`. Never push directly to either protected branch. Before
opening the beta PR run `npm run verify:local`; for Desktop changes run
`npm run verify:local:full`. The short GitHub Windows result confirms only the
Windows integration surface and does not replace those local gates.

Prepare an isolated state directory without touching the live Codex config:

```sh
test_root=$(mktemp -d)
CODEX_HOME="$test_root/codex" \
CODEX_ROUTER_STATE_DIR="$test_root/state" \
CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex \
./install.sh --prepare-only
```

Never use a real provider key in a fixture, command argument, shell history, or
committed file. Strict mock endpoints should assert the expected upstream model,
normalized request parameters, internal-auth replacement, and absence of Codex
identity headers.
