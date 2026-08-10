import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");

test("public CI keeps automatic push and pull request triggers", () => {
  const source = workflow("ci.yml");
  assert.match(source, /^\s+push:/m);
  assert.match(source, /^\s+pull_request:/m);
  assert.match(source, /^\s+workflow_dispatch:/m);
});

test("public Python lock verification remains automatic and scheduled", () => {
  const source = workflow("python-lock.yml");
  for (const trigger of ["push", "pull_request", "schedule", "workflow_dispatch"]) {
    assert.match(source, new RegExp(`^\\s+${trigger}:`, "m"));
  }
});

test("CodeQL remains enabled for main, pull requests, and its schedule", () => {
  const source = workflow("codeql.yml");
  assert.match(source, /^\s+push:/m);
  assert.match(source, /^\s+pull_request:/m);
  assert.match(source, /^\s+schedule:/m);
  assert.match(source, /github\/codeql-action\/analyze@v4/);
});
