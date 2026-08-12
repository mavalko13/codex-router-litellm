import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function verificationPlan({
  platform = process.platform,
  full = false,
  reuseDependencies = false,
} = {}) {
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  const plan = [];
  if (!reuseDependencies) plan.push({ label: "Install root dependencies", command: npm, args: ["ci"] });
  plan.push(
    { label: "Check JavaScript syntax", command: npm, args: ["run", "check"] },
    { label: "Run the full Node test suite", command: npm, args: ["test"] },
    {
      label: "Audit production Node dependencies",
      command: npm,
      args: ["audit", "--omit=dev", "--audit-level=high"],
    },
  );
  if (platform === "win32") {
    plan.push({ label: "Parse PowerShell entrypoints", kind: "powershell", optional: false });
  } else {
    plan.push(
      { label: "Check POSIX entrypoints", kind: "posix" },
      { label: "Parse PowerShell entrypoints when pwsh is available", kind: "powershell", optional: true },
    );
  }
  return plan;
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
}

function checkPosixEntrypoints() {
  const candidates = [
    path.join(root, "install.sh"),
    ...readdirSync(path.join(root, "scripts"))
      .filter((name) => name.endsWith(".sh"))
      .map((name) => path.join(root, "scripts", name)),
    ...readdirSync(path.join(root, "bin")).map((name) => path.join(root, "bin", name)),
  ];
  for (const file of candidates) {
    const shebang = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
    if (shebang === "#!/bin/sh") run("sh", ["-n", file]);
    else if (/^#!.*\bbash\b/.test(shebang)) run("bash", ["-n", file]);
  }
  run(path.join(root, "install.sh"), ["--help"]);
}

function commandAvailable(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parsePowerShellEntrypoints({ optional }) {
  const executable = process.env.PWSH_BIN || (process.platform === "win32" ? "powershell.exe" : "pwsh");
  if (optional && !commandAvailable(executable)) {
    process.stdout.write(`  SKIP: ${executable} is not installed; PowerShell parsing runs on Windows.\n`);
    return;
  }
  const files = [
    "install.ps1",
    "codex-router.ps1",
    "model-router.ps1",
  ];
  const script = [
    `$files = @(${files.map((file) => `'${file.replaceAll("'", "''")}'`).join(",")})`,
    "$failed = $false",
    "foreach ($file in $files) {",
    "  $errors = $null",
    "  [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $file), [ref]$null, [ref]$errors) | Out-Null",
    "  if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; $failed = $true }",
    "}",
    "if ($failed) { exit 1 }",
  ].join("; ");
  run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
}

export function parseVerificationArgs(args) {
  const allowed = new Set(["--full", "--reuse-deps", "--dry-run", "--help"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  return {
    full: args.includes("--full"),
    reuseDependencies: args.includes("--reuse-deps"),
    dryRun: args.includes("--dry-run"),
    help: args.includes("--help"),
  };
}

function usage() {
  process.stdout.write(
    "Usage: node scripts/verify-local.mjs [--full] [--reuse-deps] [--dry-run]\n\n" +
      "Default: clean root install, syntax, full Node suite, audit, and platform entrypoint checks.\n" +
      "--full: reserved for the complete router verification contract.\n" +
      "--reuse-deps: keep existing root dependencies for a faster repeat run.\n" +
      "--dry-run: print the exact local plan without executing it.\n",
  );
}

async function main() {
  const options = parseVerificationArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const plan = verificationPlan(options);
  if (options.dryRun) {
    for (const [index, step] of plan.entries()) {
      process.stdout.write(`${index + 1}. ${step.label}\n`);
    }
    return;
  }
  const started = Date.now();
  for (const [index, step] of plan.entries()) {
    process.stdout.write(`\n[${index + 1}/${plan.length}] ${step.label}\n`);
    if (step.kind === "posix") checkPosixEntrypoints();
    else if (step.kind === "powershell") parsePowerShellEntrypoints(step);
    else run(step.command, step.args);
  }
  process.stdout.write(`\nLocal verification passed in ${Math.ceil((Date.now() - started) / 1000)}s.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[verify-local] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
