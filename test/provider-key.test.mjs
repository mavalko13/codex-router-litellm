import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// provider-key.mjs is a CLI entry that validates process.argv at module
// evaluation time (and exits when the arguments are missing), so give it a
// valid invocation before importing it. The status command sets a non-zero
// exit code when the key is absent, which would fail this whole test file on
// machines without an opencode credential, so supply one via the environment.
const savedArgv = [...process.argv];
const savedEnvKey = process.env.OPENCODE_GO_API_KEY;
process.argv = [process.argv[0], "provider-key.mjs", "opencode-go", "status"];
process.env.OPENCODE_GO_API_KEY = "test-only-placeholder";
const { WINDOWS_HIDDEN_PROMPT_SCRIPT, powerShellStartupError, windowsHiddenPromptArgs } =
  await import("../src/provider-key.mjs");
// Lives in provider-onboarding so doctor and the providers CLI can ask the
// same question; provider-key.mjs exits on import when argv is not a command.
const { providerNeedsCuration } = await import("../src/provider-onboarding.mjs");
process.argv = savedArgv;
if (savedEnvKey === undefined) delete process.env.OPENCODE_GO_API_KEY;
else process.env.OPENCODE_GO_API_KEY = savedEnvKey;
process.exitCode = 0;

test("the Windows hidden-prompt script is structurally valid PowerShell", () => {
  // Joining the script pieces with "; " must not split `try { }` from
  // `finally { }`: PowerShell rejects "}; finally" with
  // MissingCatchOrFinally, which made every hidden key prompt fail on
  // Windows before the prompt was even shown.
  assert.doesNotMatch(WINDOWS_HIDDEN_PROMPT_SCRIPT, /}\s*;\s*finally/i);
  assert.match(WINDOWS_HIDDEN_PROMPT_SCRIPT, /}\s*finally\s*{/i);
  assert.match(WINDOWS_HIDDEN_PROMPT_SCRIPT, /-AsSecureString/);

  const opens = (WINDOWS_HIDDEN_PROMPT_SCRIPT.match(/\{/g) || []).length;
  const closes = (WINDOWS_HIDDEN_PROMPT_SCRIPT.match(/\}/g) || []).length;
  assert.equal(opens, closes);
});

test("a missing PowerShell candidate never masks the real prompt failure", () => {
  const real = Object.assign(new Error("Command failed: powershell.exe"), { status: 1 });
  const missing = Object.assign(new Error("spawnSync pwsh.exe ENOENT"), { code: "ENOENT" });

  // The reported case: powershell.exe fails for a real reason, pwsh.exe is
  // simply not installed, and the user is shown "pwsh.exe ENOENT" instead of
  // the failure that actually stopped them entering a key.
  assert.equal(powerShellStartupError([real, missing]), real);
  assert.equal(powerShellStartupError([missing, real]), real);

  // Every candidate absent is the one case where ENOENT is the whole story,
  // and it deserves a message that names the missing dependency.
  const noneInstalled = powerShellStartupError([missing, missing]);
  assert.equal(noneInstalled.code, undefined);
  assert.match(noneInstalled.message, /PowerShell is required/);
});

test("every interactive Windows prompt uses shared candidate error selection", () => {
  for (const relative of [
    "src/setup.mjs",
    "src/setup-shared.mjs",
    "src/provider-endpoint.mjs",
    "src/provider-key.mjs",
  ]) {
    const source = readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /powerShellStartupError/);
    assert.match(source, /WINDOWS_POWERSHELL_CANDIDATES/);
    assert.doesNotMatch(source, /throw lastError \|\| new Error\("PowerShell is required/);
  }
});

test("the Windows hidden prompt is passed as an encoded command", () => {
  const args = windowsHiddenPromptArgs();
  // -Command hands the script to the Windows command-line parser before
  // PowerShell sees it; the prompt must not depend on surviving that.
  assert.equal(args.includes("-Command"), false);
  const encodedIndex = args.indexOf("-EncodedCommand");
  assert.ok(encodedIndex >= 0);
  const encoded = args[encodedIndex + 1];
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  // PowerShell decodes -EncodedCommand as UTF-16LE; any other encoding
  // produces a script that parses as garbage.
  assert.equal(
    Buffer.from(encoded, "base64").toString("utf16le"),
    WINDOWS_HIDDEN_PROMPT_SCRIPT,
  );
});

test(
  "the Windows hidden-prompt script parses under powershell.exe",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-prompt-"));
    const scriptPath = path.join(testRoot, "hidden-prompt.ps1");
    try {
      writeFileSync(scriptPath, WINDOWS_HIDDEN_PROMPT_SCRIPT, "utf8");
      const escaped = scriptPath.replaceAll("'", "''");
      const check = [
        "$tokens = $null; $errors = $null",
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
        "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
      ].join("; ");
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test("a catalog-only provider points the user at curation after a key is stored", () => {
  // gemini-api and the other catalog-only providers register zero models, so
  // "the provider is enabled" alone leaves an empty picker and the key reads
  // as broken. This is what PR #76 tried to solve by hardcoding models.
  const models = [{ provider: "deepseek" }, { provider: "deepseek" }];
  assert.equal(providerNeedsCuration("gemini-api", models), true);
  assert.equal(providerNeedsCuration("deepseek", models), false);
});

test("a curated model silences the curation hint", () => {
  // Once the user has curated anything, the picker is no longer empty and
  // repeating the instruction would just be noise.
  const models = [{ provider: "gemini-api", slug: "gemini-api/curated" }];
  assert.equal(providerNeedsCuration("gemini-api", models), false);
});
