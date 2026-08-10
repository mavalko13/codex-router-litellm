[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [switch]$ForceDeps,
  [ValidateSet("codex")]
  [string]$Target = "codex",
  [switch]$Guided,
  [switch]$Auto,
  [string]$Providers,
  [switch]$MigrateKnown,
  [switch]$AdoptNativeCatalog,
  [switch]$SmokeTest,
  # Discards tracked edits in the managed checkout so the update can proceed.
  # Deliberately never touches untracked files -- see Reset-ManagedCheckout.
  [switch]$Force,
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
if ($Target -ne "codex" -and $MigrateKnown) {
  throw "-MigrateKnown applies only to the Codex target."
}
if ($PrepareOnly -and $AdoptNativeCatalog) {
  throw "-AdoptNativeCatalog cannot be used with -PrepareOnly."
}
if ($MigrateKnown -and $AdoptNativeCatalog) {
  throw "-AdoptNativeCatalog cannot be combined with -MigrateKnown."
}
$PreviousRevision = $null
$RepositoryUrl = if ($env:CODEX_ROUTER_REPOSITORY_URL) {
  $env:CODEX_ROUTER_REPOSITORY_URL
} else {
  "https://github.com/mavalko13/codex-router-litellm.git"
}
$UseGuided = $Guided -or (-not $Auto -and [Environment]::UserInteractive)

function Update-ProcessPath {
  $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($MachinePath, $UserPath, $env:Path) | Where-Object { $_ }) -join ";"
}

function Confirm-PackageInstall([string]$DisplayName) {
  if (-not $UseGuided) { return $false }
  $Answer = Read-Host "$DisplayName is required. Install it with WinGet now? [Y/n]"
  return -not $Answer -or $Answer.Trim().ToLowerInvariant() -in @("y", "yes")
}

function Install-WinGetPackage(
  [string]$Id,
  [string]$DisplayName,
  [scriptblock]$Ready,
  [string]$Help
) {
  if (& $Ready) { return }
  if (-not (Confirm-PackageInstall $DisplayName)) { throw "$DisplayName is required. $Help" }
  if (-not (Get-Command "winget" -ErrorAction SilentlyContinue)) {
    throw "$DisplayName is required and WinGet is unavailable. $Help"
  }
  $WingetAction = if ($Id -eq "OpenJS.NodeJS.LTS" -and (Get-Command "node" -ErrorAction SilentlyContinue)) {
    "upgrade"
  } else {
    "install"
  }
  & winget $WingetAction --id=$Id -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "WinGet could not install $DisplayName. $Help" }
  Update-ProcessPath
  if (-not (& $Ready)) {
    throw "$DisplayName was installed but is not available in this PowerShell process. Reopen PowerShell and rerun the same installer command."
  }
}

function Test-NodeVersion {
  if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) { return $false }
  try {
    $Parts = (& node -p "process.versions.node").Trim().Split(".")
    return [int]$Parts[0] -gt 22 -or ([int]$Parts[0] -eq 22 -and [int]$Parts[1] -ge 19)
  } catch {
    return $false
  }
}

function Test-PythonRuntime {
  if (Get-Command "uv" -ErrorAction SilentlyContinue) { return $true }
  foreach ($Candidate in @(
    @{ Command = "py"; Arguments = @("-3", "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)") },
    @{ Command = "python"; Arguments = @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)") }
  )) {
    if (-not (Get-Command $Candidate.Command -ErrorAction SilentlyContinue)) { continue }
    $CandidateCommand = $Candidate.Command
    $CandidateArguments = $Candidate.Arguments
    & $CandidateCommand @CandidateArguments 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}

function Assert-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Help"
  }
}

function Test-RouterCheckout([string]$Directory) {
  $Package = Join-Path $Directory "package.json"
  if (-not (Test-Path $Package)) { return $false }
  try {
    return (Get-Content $Package -Raw | ConvertFrom-Json).name -eq "codex-model-router"
  } catch {
    return $false
  }
}

# Mirrors DIRTY_PREVIEW_LIMIT in src/update.mjs. test/installer-scripts.test.mjs
# imports that constant and compares it with this one, so the two cannot drift.
$DirtyPreviewLimit = 10

# Mirrors localModifications() in src/update.mjs. Only tracked edits are at
# stake: a fast-forward pull never replaces an untracked file, and git refuses
# the rare collision on its own with a precise message. Counting untracked files
# as "local changes" only ever stranded people -- one stray file in the checkout
# and every later self-update was refused.
function Get-LocalModification([string]$Directory) {
  $Output = @(& git -C $Directory status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the Git status of $Directory." }
  return @($Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

# Mirrors localModificationsMessage() in src/update.mjs. Naming the files and
# both ways forward is the whole point: the old message named neither, so anyone
# blocked by a single stray edit had nothing to act on.
function Get-LocalModificationMessage([string[]]$Changes, [string]$Directory) {
  $Plural = if ($Changes.Count -eq 1) { "" } else { "s" }
  $Lines = @(
    "The checkout has local changes to $($Changes.Count) tracked file${Plural}; refusing to replace them during update:"
  )
  $Lines += @($Changes | Select-Object -First $DirtyPreviewLimit | ForEach-Object { "  $_" })
  $Remainder = $Changes.Count - $DirtyPreviewLimit
  if ($Remainder -gt 0) { $Lines += "  ...and $Remainder more" }
  $Lines += ""
  $Lines += "Keep them:    git -C $Directory stash"
  $Lines += "Discard them: re-run the same command with -Force"
  return ($Lines -join "`n")
}

# Mirrors requireReplaceableCheckout() in src/update.mjs, including its refusal
# to reach for `git clean`: -Force restores files git already tracks and leaves
# untracked files exactly where they are, because an update has no business
# deleting work git was never asked to track.
function Reset-ManagedCheckout([string]$Directory) {
  & git -C $Directory reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "Unable to discard the local changes in $Directory." }
}

$ScriptDirectory = $PSScriptRoot
if (-not $ScriptDirectory) { $ScriptDirectory = (Get-Location).Path }

if (-not $CheckoutInstall) {
  Install-WinGetPackage "Git.Git" "Git for Windows" {
    [bool](Get-Command "git" -ErrorAction SilentlyContinue)
  } "Install Git for Windows from https://git-scm.com/download/win."
  Install-WinGetPackage "OpenJS.NodeJS.LTS" "Node.js 24 LTS" {
    Test-NodeVersion
  } "Install Node.js 24 LTS from https://nodejs.org/."
  Install-WinGetPackage "astral-sh.uv" "uv with managed Python 3.12" {
    Test-PythonRuntime
  } "Install uv from https://docs.astral.sh/uv/."
  Assert-Command "npm" "npm is included with Node.js."

  if (Test-RouterCheckout $ScriptDirectory) {
    $Repository = $ScriptDirectory
  } else {
    if (Test-Path (Join-Path $InstallDir ".git")) {
      if (-not (Test-RouterCheckout $InstallDir)) {
        throw "$InstallDir is not a Codex Router checkout."
      }
      $Origin = (& git -C $InstallDir remote get-url origin).Trim()
      $AllowedOrigins = @(
        $RepositoryUrl,
        "https://github.com/mavalko13/codex-router-litellm",
        "https://github.com/mavalko13/codex-router-litellm.git",
        "git@github.com:mavalko13/codex-router-litellm.git"
      ) | Where-Object { $_ }
      if ($Origin -notin $AllowedOrigins) {
        throw "$InstallDir has an unrecognized origin and will not be updated: $Origin"
      }
      # PowerShell unrolls a one-element array on return, so re-wrap before
      # reading .Count.
      $Dirty = @(Get-LocalModification $InstallDir)
      if ($Dirty.Count) {
        if (-not $Force) { throw (Get-LocalModificationMessage $Dirty $InstallDir) }
        Reset-ManagedCheckout $InstallDir
      }
      # A failed setup rolls the checkout back to a detached HEAD (see the
      # rollback below), where `branch --show-current` prints nothing. A native
      # command with no output yields $null, and in Windows PowerShell 5.1
      # [string]$null stays $null, so guard explicitly before calling Trim().
      $Branch = & git -C $InstallDir branch --show-current
      if ($null -eq $Branch) { $Branch = "" }
      $Branch = [string]$Branch.Trim()
      if ($Branch -ne "main") {
        if (-not $Branch) {
          & git -C $InstallDir switch main 2>$null
          if ($LASTEXITCODE -ne 0) {
            throw "$InstallDir is in a detached HEAD state and could not be restored to main; run 'git switch main' there and retry."
          }
          $Branch = & git -C $InstallDir branch --show-current
          if ($null -eq $Branch) { $Branch = "" }
          $Branch = [string]$Branch.Trim()
        }
        if ($Branch -ne "main") { throw "$InstallDir must be on its main branch to update." }
      }
      $PreviousRevision = (& git -C $InstallDir rev-parse HEAD).Trim()
      & git -C $InstallDir update-ref refs/codex-router/rollback $PreviousRevision
      & git -C $InstallDir pull --ff-only origin main
      if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward the managed checkout." }
    } elseif (Test-Path $InstallDir) {
      throw "$InstallDir exists and is not a Codex Router checkout."
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
      & git clone --depth 1 $RepositoryUrl $InstallDir
      if ($LASTEXITCODE -ne 0) { throw "Unable to clone Codex Router." }
    }
    $Repository = $InstallDir
  }

  # setup.mjs imports the state transaction layer, which uses runtime npm
  # packages such as proper-lockfile. A fresh clone has no node_modules yet,
  # so bootstrap Node dependencies before the first setup import. The inner
  # checkout installer uses the same fingerprint and will skip this work.
  Push-Location $Repository
  try {
    $NodeDependencyStatus = (& node src/install-plan.mjs status node-deps 2>$null | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or "$NodeDependencyStatus".Trim() -ne "skip") {
      & npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) { throw "npm dependency bootstrap failed." }
      & node src/install-plan.mjs record node-deps
      if ($LASTEXITCODE -ne 0) { throw "Recording the Node dependency state failed." }
    }
  } catch {
    if ($PreviousRevision) {
      & git -C $Repository switch --detach $PreviousRevision 2>$null | Out-Null
      Write-Warning "Dependency bootstrap failed; the managed source checkout was restored to $PreviousRevision."
    }
    throw
  } finally {
    Pop-Location
  }

  if ($PrepareOnly) {
    & (Join-Path $Repository "install.ps1") -CheckoutInstall -PrepareOnly -Target $Target
    exit $LASTEXITCODE
  }

  $SetupScript = "src\setup.mjs"
  $SetupArguments = @((Join-Path $Repository $SetupScript))
  if ($UseGuided) { $SetupArguments += "--guided" }
  if ($Providers) { $SetupArguments += @("--providers", $Providers) }
  if ($MigrateKnown) { $SetupArguments += "--migrate-known" }
  if ($AdoptNativeCatalog) { $SetupArguments += "--adopt-native-catalog" }
  if ($SmokeTest) { $SetupArguments += "--smoke-test" }
  & node @SetupArguments
  $SetupExitCode = $LASTEXITCODE
  # Exit 2 means setup left configuration unfinished (a declined prompt, a
  # missing credential) and says nothing about the code that was just pulled.
  # Rolling back there discards the update the user ran this for, and if the
  # unfinished step is itself the bug being fixed, every retry repeats it.
  # Any other non-zero code still restores the checkout, so the running
  # service is never left on half-applied code by an unrecognized failure.
  if ($SetupExitCode -eq 2) {
    Write-Warning "Setup did not finish configuring; the update was kept. Re-run setup to continue, or ./codex-router.ps1 rollback to return to the previous revision."
  } elseif ($SetupExitCode -ne 0 -and $PreviousRevision) {
    & git -C $Repository switch --detach $PreviousRevision 2>$null | Out-Null
    Write-Warning "Setup failed; the managed source checkout was restored to $PreviousRevision."
  }
  exit $SetupExitCode
}

if (-not (Test-RouterCheckout $ScriptDirectory)) {
  throw "-CheckoutInstall must be run from a Codex Router checkout."
}

Assert-Command "node" "Install Node.js 24 LTS from https://nodejs.org/."
Assert-Command "npm" "npm is included with Node.js."
$VersionParts = (node -p "process.versions.node").Split(".")
if ([int]$VersionParts[0] -lt 22 -or
    ([int]$VersionParts[0] -eq 22 -and [int]$VersionParts[1] -lt 19)) {
  throw "Node.js 22.19 or newer is required; Node.js 24 LTS is recommended."
}

Push-Location $ScriptDirectory
try {
  if ($Target -eq "codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
    $LegacyArguments = @("src\legacy-migration.mjs", "assert-clear")
    if ($AdoptNativeCatalog) { $LegacyArguments += "--adopt-native-catalog" }
    & node @LegacyArguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Resolve the detected older router before installing." }
  }
  if (-not $PrepareOnly) {
    & node src/provider-selection.mjs ensure-configured | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Configure at least one provider before installing." }
  }

  # Every update re-runs this installer, so the dependency steps are skipped
  # when their inputs are unchanged; -ForceDeps (used by doctor --fix) rebuilds
  # them.
  function Get-InstallStep([string]$Step) {
    if ($ForceDeps) { return "run" }
    try {
      $Status = (& node src/install-plan.mjs status $Step 2>$null | Select-Object -Last 1)
      if ($LASTEXITCODE -ne 0) { return "run" }
      return "$Status".Trim()
    } catch {
      return "run"
    }
  }

  if ((Get-InstallStep "node-deps") -eq "skip") {
    Write-Host "Node dependencies already match package-lock.json; skipping npm ci."
  } else {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }
    & node src/install-plan.mjs record node-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Node dependency state failed." }
  }

  $Python = Join-Path $ScriptDirectory ".venv\Scripts\python.exe"
  if ((Get-InstallStep "python-deps") -eq "skip") {
    Write-Host "LiteLLM already matches the pinned versions; skipping the Python install."
  } elseif (Get-Command "uv" -ErrorAction SilentlyContinue) {
    if (-not (Test-Path $Python)) {
      & uv venv --python 3.12 .venv
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    }
    # requirements/python.txt is the hash-verified transitive closure of the
    # pins in src/install-plan.mjs. Hash checking makes every wheel and sdist
    # in that tree verify against the lock before it is executed; without it
    # only the two top-level packages were pinned and the rest was whatever
    # PyPI resolved that day. Regenerate with bin/lock-python, never by hand.
    & uv pip install --python $Python --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
  } else {
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
      & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) { & py -3 -m venv .venv }
    } elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
      & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) { & python -m venv .venv }
    } else {
      throw "Python 3.10+ or uv is required. Install uv from https://docs.astral.sh/uv/."
    }
    if (-not (Test-Path $Python)) { throw "The Python virtual environment was not created." }
    & $Python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
    # Same hash-verified lock as the uv branch above; both stay hash-checked.
    & $Python -m pip install --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
  }

  if ($PrepareOnly) {
    # The shared helper checks state ownership before its first write, so a
    # foreign checkout cannot mutate the live state through -PrepareOnly.
    & node src/install-transaction.mjs prepare
    if ($LASTEXITCODE -ne 0) { throw "Preparing shared router state failed." }
    Write-Host "Dependencies and generated files are prepared; application configuration was not changed."
    exit 0
  }

  # The same transaction is used on POSIX and Windows: exact manifest/config
  # and service definition/running state are restored after every failed step.
  $TransactionArguments = @("src\install-transaction.mjs", "apply")
  if ($AdoptNativeCatalog) { $TransactionArguments += "--adopt-native-catalog" }
  & node @TransactionArguments
  if ($LASTEXITCODE -ne 0) { throw "Router installation transaction failed." }
  # Match bin/install: custom routed models need these skills to restore the
  # Codex app's native tools. This happens after the shared transaction commits
  # so a best-effort skill-copy failure cannot roll back a healthy router.
  & node src\skills-install.mjs install
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "The router is installed, but the Codex skill pack could not be refreshed. Retry with: node src\skills-install.mjs install"
  }
  Write-Host "Installed the selected external model routes. Fully quit and reopen Codex."
} catch {
  throw
} finally {
  Pop-Location
}
