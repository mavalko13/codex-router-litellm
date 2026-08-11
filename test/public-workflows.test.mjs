import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");

test("public CI keeps a short Windows-only pull request gate", () => {
  const source = workflow("ci.yml");
  assert.match(source, /^\s+pull_request:/m);
  assert.match(source, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(source, /^\s+push:/m);
  assert.match(source, /branches: \[beta, main\]/);
  assert.match(source, /runs-on: windows-latest/);
  assert.doesNotMatch(source, /macos-latest/);
  assert.doesNotMatch(source, /ubuntu-latest/);
});

test("public CI runs only the short Windows service and installer regression set", () => {
  const source = workflow("ci.yml");
  assert.match(source, /Run Windows service and installer regressions/);
  assert.match(source, /node --test test\/service-render\.test\.mjs test\/windows-process-tree\.test\.mjs test\/installer-scripts\.test\.mjs test\/installer-handoff\.test\.mjs/);
  assert.match(source, /Parse PowerShell entrypoints/);
  assert.match(source, /timeout-minutes: 8/);
});

test("public Python lock verification is opt-in", () => {
  const source = workflow("python-lock.yml");
  assert.match(source, /^\s+workflow_dispatch:/m);
  for (const trigger of ["push", "pull_request", "schedule"]) assert.doesNotMatch(source, new RegExp(`^\\s+${trigger}:`, "m"));
});

test("CodeQL remains enabled for main, pull requests, and its schedule", () => {
  const source = workflow("codeql.yml");
  assert.match(source, /^\s+push:/m);
  assert.match(source, /^\s+pull_request:/m);
  assert.match(source, /^\s+schedule:/m);
  assert.match(source, /github\/codeql-action\/analyze@v4/);
});
