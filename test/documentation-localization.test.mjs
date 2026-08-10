import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

test("English and Russian entrypoints link to each other", () => {
  const english = read("README.md");
  const russian = read("README.ru.md");
  assert.match(english, /\[Русский\]\(README\.ru\.md\)/);
  assert.match(russian, /\[English\]\(README\.md\)/);
  assert.match(english, /docs\/LITELLM-GATEWAY\.md/);
  assert.match(russian, /docs\/LITELLM-GATEWAY\.ru\.md/);
});

test("both LiteLLM guides keep the same operator commands and safety contract", () => {
  const english = read("docs", "LITELLM-GATEWAY.md");
  const russian = read("docs", "LITELLM-GATEWAY.ru.md");
  for (const required of [
    "provider-endpoint litellm-gateway set",
    "provider-key litellm-gateway set",
    "discover-models litellm-gateway",
    "curate-models litellm-gateway",
    "CODEX_ROUTER_LITELLM_BASE_URL",
    "CODEX_ROUTER_LITELLM_API_KEY",
    "provider-endpoints.json",
    "litellm-gateway-api-key.secret",
    "support-bundle",
    "Windows",
    "main",
  ]) {
    assert.ok(english.includes(required), `English guide is missing ${required}`);
    assert.ok(russian.includes(required), `Russian guide is missing ${required}`);
  }
  assert.match(english, /master key/i);
  assert.match(russian, /master key/i);
  assert.match(english, /separate private repository/i);
  assert.match(russian, /отдельном\s+приватном\s+репозитории/i);
});
