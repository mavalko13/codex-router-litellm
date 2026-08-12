import assert from "node:assert/strict";
import test from "node:test";

import { parseVerificationArgs, verificationPlan } from "../scripts/verify-local.mjs";

test("default local verification mirrors the core CI contract", () => {
  const labels = verificationPlan({ platform: "darwin" }).map((step) => step.label);
  assert.deepEqual(labels, [
    "Install root dependencies",
    "Check JavaScript syntax",
    "Run the full Node test suite",
    "Audit production Node dependencies",
    "Check POSIX entrypoints",
    "Parse PowerShell entrypoints when pwsh is available",
  ]);
});

test("full local verification retains the core verification contract", () => {
  const plan = verificationPlan({ platform: "win32", full: true });
  assert.ok(plan.some((step) => step.label === "Parse PowerShell entrypoints"));
  assert.ok(plan.some((step) => step.label === "Run the full Node test suite"));
});

test("fast repeats reuse dependencies without skipping verification", () => {
  const plan = verificationPlan({ reuseDependencies: true, full: true });
  assert.equal(plan.some((step) => step.label.startsWith("Install ")), false);
  assert.ok(plan.some((step) => step.label === "Run the full Node test suite"));
  assert.ok(plan.some((step) => step.label === "Run the full Node test suite"));
});

test("local verification rejects unknown options", () => {
  assert.throws(() => parseVerificationArgs(["--paid-cloud"]), /Unknown option/);
});

test("dry-run is an explicit side-effect-free mode", () => {
  assert.equal(parseVerificationArgs(["--full", "--dry-run"]).dryRun, true);
});
