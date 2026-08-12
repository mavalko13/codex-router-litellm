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

test("CodeQL PR keeps JavaScript analysis on every main pull request", () => {
  const source = workflow("codeql.yml");
  assert.match(source, /^\s+pull_request:/m);
  assert.match(source, /branches: \[main\]/);
  for (const trigger of ["push", "schedule", "workflow_dispatch"]) {
    assert.doesNotMatch(source, new RegExp(`^\\s+${trigger}:`, "m"));
  }
  assert.match(source, /analyze-javascript:/);
  assert.match(source, /languages: javascript-typescript/);
  assert.match(source, /security-extended/);
  assert.match(source, /codeql\/javascript-queries:AlertSuppression\.ql/);
  assert.match(source, /category: \.github\/workflows\/codeql\.yml:analyze/);
  assert.doesNotMatch(source, /Apply source suppressions/);
});

test("CodeQL PR gates Swift with first-party Swift-relevant path detection", () => {
  const source = workflow("codeql.yml");
  const matcher = source.match(/grep -zEq '([^']+)'/);
  assert.ok(matcher, "CodeQL PR workflow must contain a changed-file matcher");
  const isSwiftRelevant = (file) => new RegExp(matcher[1]).test(file);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /git diff --name-only --no-renames -z "\$BASE_SHA" "\$HEAD_SHA" > "\$changed_files"/);
  assert.match(source, /grep -zEq/);
  assert.match(source, /\$RUNNER_TEMP\/codeql-swift-changed-files/);
  assert.match(source, /::warning::Unable to detect Swift-relevant changes; running Swift CodeQL\./);
  assert.match(source, /::warning::Unable to evaluate Swift-relevant changes; running Swift CodeQL\./);
  assert.match(source, /echo "swift_changed=true" >> "\$GITHUB_OUTPUT"\n\s+exit 0/);
  assert.match(source, /apps\/macos\//);
  assert.match(source, /Package\\\.\(swift\|resolved\)/);
  assert.match(source, /\.github\/\(workflows\/codeql/);
  assert.match(source, /\.codeql\//);
  assert.match(source, /codeql-config\\\.ya\?ml/);
  assert.match(source, /scripts\/build-macos-tray-app\\\.sh/);
  assert.match(source, /if: needs\.changes\.outputs\.swift_changed == 'true'/);
  assert.match(source, /languages: swift/);
  assert.match(source, /security-extended/);
  assert.match(source, /codeql\/swift-queries:AlertSuppression\.ql/);
  assert.doesNotMatch(source, /dorny\/paths-filter|tj-actions\/changed-files/);
  assert.doesNotMatch(source, /cache:|\.build/);

  for (const file of [
    "apps/macos/ModelRouterTray/Sources/App.swift",
    "apps/macos/ModelRouterTray/Sources/Überprüfung.swift",
    "Package.swift",
    "Package.resolved",
    "apps/macos/ModelRouterTray/Package.swift",
    "apps/macos/ModelRouterTray/.build/checkouts/Dependency/Package.resolved",
    ".github/workflows/codeql.yml",
    ".github/workflows/codeql-full.yml",
    ".github/codeql-config.yml",
    ".github/codeql/custom.ql",
    "codeql-config.yaml",
    "scripts/build-macos-tray-app.sh",
    ".swift-version",
    "Makefile",
    "justfile",
    "xcodegen.yml",
    "project.yaml",
  ]) {
    assert.equal(isSwiftRelevant(file), true, `${file} must enable Swift CodeQL`);
  }

  for (const file of ["src/router.mjs", "README.md", "docs/architecture.md", "apps/desktop/src-tauri/src/main.rs"]) {
    assert.equal(isSwiftRelevant(file), false, `${file} must not enable Swift CodeQL`);
  }

  assert.equal(
    ["apps/macos/ModelRouterTray/Sources/App.swift", "src/tray-app.mjs"].some(isSwiftRelevant),
    true,
    "moving a file out of apps/macos must retain the old path through --no-renames",
  );
  assert.equal(
    ["apps/macos/ModelRouterTray/Package.swift", "src/package-manifest.txt"].some(isSwiftRelevant),
    true,
    "renaming Package.swift must retain the old path through --no-renames",
  );
});

test("CodeQL Full always scans both languages and suppresses only main pushes", () => {
  const source = workflow("codeql-full.yml");
  assert.match(source, /^\s+push:/m);
  assert.match(source, /^\s+schedule:/m);
  assert.match(source, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(source, /^\s+pull_request:/m);
  assert.match(source, /languages: javascript-typescript/);
  assert.match(source, /category: \.github\/workflows\/codeql\.yml:analyze/);
  assert.match(source, /languages: swift/);
  assert.match(source, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(source, /needs\.changes|swift_changed|cache:|\.build/);
});
