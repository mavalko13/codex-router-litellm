export const WINDOWS_POWERSHELL_CANDIDATES = Object.freeze([
  "powershell.exe",
  "pwsh.exe",
]);

// Stock Windows includes powershell.exe but not pwsh.exe. If the stock shell
// starts and its prompt fails (for example because pasted input reached EOF),
// the later ENOENT from optional PowerShell 7 must not replace the actionable
// error from the shell the operator actually has.
export function powerShellStartupError(failures, fallbackMessage = "PowerShell is required.") {
  return (
    failures.find((error) => error?.code !== "ENOENT") ||
    new Error(fallbackMessage)
  );
}
