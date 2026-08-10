import { execFileSync } from "node:child_process";

import { WINDOWS_POWERSHELL_CANDIDATES } from "./windows-powershell.mjs";

export function windowsProcessTreeStopScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$start = [IO.Path]::GetFullPath($env:CODEX_ROUTER_START_SCRIPT)",
    "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
    "do {",
    "  $owned = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($start, [StringComparison]::OrdinalIgnoreCase) -ge 0 })",
    "  foreach ($process in $owned) { & taskkill.exe /PID $process.ProcessId /T /F | Out-Null }",
    "  if (-not $owned.Count) { exit 0 }",
    "  Start-Sleep -Milliseconds 200",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "exit 1",
  ].join("; ");
}

export function terminateWindowsProcessTrees(
  startPath,
  {
    candidates = WINDOWS_POWERSHELL_CANDIDATES.map((executable) => [executable, []]),
    timeoutMs = 25_000,
  } = {},
) {
  const script = windowsProcessTreeStopScript();
  for (const [executable, prefixArgs] of candidates) {
    try {
      execFileSync(
        executable,
        [...prefixArgs, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { ...process.env, CODEX_ROUTER_START_SCRIPT: startPath },
          stdio: ["ignore", "ignore", "ignore"],
          timeout: timeoutMs,
        },
      );
      return;
    } catch {
      // Stock Windows PowerShell is tried before optional PowerShell Core. A
      // restricted or missing shell falls through to the next candidate.
    }
  }
  throw new Error("Unable to stop the existing Codex Router process tree.");
}
