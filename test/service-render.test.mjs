import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceEnv(platform, testRoot, target = "codex") {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex home"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
    MODEL_ROUTER_TARGET: target,
    CODEX_ROUTER_SERVICE_PLATFORM: platform,
    XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
  };
}

function serviceCommand(
  script,
  platform,
  testRoot,
  command = "render",
  target = "codex",
  sourceRoot = root,
  env = {},
) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(
    process.execPath,
    [...nodeArgs, path.join(sourceRoot, "src", script), command],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...serviceEnv(platform, testRoot, target), ...env },
    },
  );
}

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  return serviceCommand(script, platform, testRoot, "render", target, sourceRoot);
}

function writeExecutable(target, contents) {
  writeFileSync(target, contents, { mode: 0o700 });
  chmodSync(target, 0o700);
}

// Mirrors src/service-windows.mjs: MODEL_ROUTER_STATE_DIR wins over every other
// state-directory source, and the fixture name deliberately carries a space.
function windowsStateDir(testRoot) {
  return path.join(testRoot, "codex router state");
}

// Mirrors the quoting in src/service-linux.mjs. Fixture paths are host-shaped,
// so on Windows they carry backslashes that the unit file has to escape; the
// expectation has to escape them too or the test only passes on POSIX hosts.
function systemdQuoted(value) {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);
    assert.match(windows, /if "%router_status%"=="75" goto router_restart/);
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("packaged services persist stable source and Node paths", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-packaged-service-"));
  const stableRoot = path.join(testRoot, "opt", "codex-router", "libexec");
  const stableNode = path.join(testRoot, "opt", "node", "bin", "node");
  const env = {
    CODEX_ROUTER_SOURCE_ROOT: stableRoot,
    CODEX_ROUTER_NODE_BIN: stableNode,
    CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
  };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.match(launchd, new RegExp(stableNode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(launchd, /<key>CODEX_ROUTER_SOURCE_ROOT<\/key>/);
    assert.match(launchd, /<key>CODEX_ROUTER_NODE_BIN<\/key>/);
    assert.match(launchd, /<string>homebrew<\/string>/);

    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(systemd.includes(`WorkingDirectory=${stableRoot.replaceAll("%", "%%")}`));
    assert.ok(systemd.includes(`ExecStart=${systemdQuoted(stableNode)}`));
    assert.ok(systemd.includes(`Environment="CODEX_ROUTER_PACKAGE_MANAGER=homebrew"`));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("macOS, Linux, and Windows service snapshots restore the exact old definition and running state", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-rollback-"));
  const fakeBin = path.join(testRoot, "bin");
  mkdirSync(fakeBin, { recursive: true });
  try {
    const managerState = path.join(testRoot, "manager-state");
    const managerEnabled = path.join(testRoot, "manager-enabled");
    const taskPresent = path.join(testRoot, "task-present");
    const taskXml = path.join(testRoot, "task.xml");
    const launchctl = path.join(fakeBin, "launchctl");
    writeExecutable(
      launchctl,
      `#!/bin/sh
case "$1" in
  print) [ "$(cat "$CODEX_ROUTER_TEST_MANAGER_STATE")" = running ] && echo "state = running" || exit 1 ;;
  bootout) echo stopped > "$CODEX_ROUTER_TEST_MANAGER_STATE" ;;
  bootstrap|kickstart) echo running > "$CODEX_ROUTER_TEST_MANAGER_STATE" ;;
  enable|disable) ;;
  *) exit 2 ;;
esac
exit 0
`,
    );
    const systemctl = path.join(fakeBin, "systemctl.mjs");
    writeFileSync(
      systemctl,
      `import { readFileSync, writeFileSync } from "node:fs";
let args = process.argv.slice(2);
if (args[0] === "--user") args = args.slice(1);
const [command, ...rest] = args;
const state = process.env.CODEX_ROUTER_TEST_MANAGER_STATE;
const enabled = process.env.CODEX_ROUTER_TEST_MANAGER_ENABLED;
const read = (target) => readFileSync(target, "utf8").trim();
const write = (target, value) => writeFileSync(target, value + "\\n");
if (command === "is-active") {
  if (read(state) === "running") process.stdout.write("active\\n");
  else { process.stdout.write("inactive\\n"); process.exitCode = 3; }
} else if (command === "is-enabled") {
  if (read(enabled) === "enabled") process.stdout.write("enabled\\n");
  else { process.stdout.write("disabled\\n"); process.exitCode = 1; }
} else if (command === "daemon-reload") {
  // no-op
} else if (command === "stop") {
  write(state, "stopped");
} else if (command === "start" || command === "restart") {
  write(state, "running");
} else if (command === "enable") {
  write(enabled, "enabled");
  if (rest[0] === "--now") write(state, "running");
} else if (command === "disable") {
  write(enabled, "disabled");
  if (rest[0] === "--now") write(state, "stopped");
} else {
  process.exitCode = 2;
}
`,
    );
    const schtasks = path.join(fakeBin, "schtasks.mjs");
    writeFileSync(
      schtasks,
      `import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args[0];
const present = process.env.CODEX_ROUTER_TEST_TASK_PRESENT;
const xml = process.env.CODEX_ROUTER_TEST_TASK_XML;
const state = process.env.CODEX_ROUTER_TEST_MANAGER_STATE;
const read = (target) => readFileSync(target, "utf8").trim();
const write = (target, value) => writeFileSync(target, value + "\\n");
if (command === "/Query") {
  if (read(present) !== "yes") process.exit(1);
  if (args.includes("/XML")) process.stdout.write(readFileSync(xml));
  else process.stdout.write("task\\n");
} else if (command === "/End") write(state, "ready");
else if (command === "/Delete") write(present, "no");
else if (command === "/Run") write(state, "running");
else if (command === "/Create") {
  const index = args.indexOf("/XML");
  if (index !== -1) copyFileSync(args[index + 1], xml);
  write(present, "yes");
} else process.exitCode = 2;
`,
    );
    const taskState = path.join(fakeBin, "task-state.mjs");
    writeFileSync(
      taskState,
      `import { readFileSync } from "node:fs";
if (readFileSync(process.env.CODEX_ROUTER_TEST_TASK_PRESENT, "utf8").trim() !== "yes") process.exit(1);
process.stdout.write(readFileSync(process.env.CODEX_ROUTER_TEST_MANAGER_STATE, "utf8").trim());
`,
    );

    const commonEnv = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_ROUTER_TEST_MANAGER_STATE: managerState,
      CODEX_ROUTER_TEST_MANAGER_ENABLED: managerEnabled,
      CODEX_ROUTER_TEST_TASK_PRESENT: taskPresent,
      CODEX_ROUTER_TEST_TASK_XML: taskXml,
    };

    // launchd definition and loaded state.
    const launchAgents = path.join(testRoot, "launch-agents");
    const plist = path.join(launchAgents, "io.github.codex-router.plist");
    const macSnapshot = path.join(testRoot, "mac-service.json");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(plist, "old launchd definition\n");
    writeFileSync(managerState, "running\n");
    // serviceCommand does not forward extra argv; invoke snapshot/restore with their path.
    const runService = (script, platform, args, env) =>
      execFileSync(process.execPath, [path.join(root, "src", script), ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...serviceEnv(platform, testRoot), ...env },
      });
    runService("service-macos.mjs", "darwin", ["snapshot", macSnapshot], {
      ...commonEnv,
      CODEX_ROUTER_LAUNCHCTL_BIN: launchctl,
      MODEL_ROUTER_LAUNCH_AGENTS_DIR: launchAgents,
    });
    writeFileSync(plist, "new launchd definition\n");
    writeFileSync(managerState, "running\n");
    runService("service-macos.mjs", "darwin", ["restore", macSnapshot], {
      ...commonEnv,
      CODEX_ROUTER_LAUNCHCTL_BIN: launchctl,
      MODEL_ROUTER_LAUNCH_AGENTS_DIR: launchAgents,
    });
    assert.equal(readFileSync(plist, "utf8"), "old launchd definition\n");
    assert.equal(readFileSync(managerState, "utf8"), "running\n");

    // systemd definition, enabled bit, and active state.
    const unit = path.join(testRoot, "xdg config", "systemd", "user", "codex-router.service");
    const linuxSnapshot = path.join(testRoot, "linux-service.json");
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, "old systemd definition\n");
    writeFileSync(managerState, "running\n");
    writeFileSync(managerEnabled, "enabled\n");
    const linuxEnv = {
      ...commonEnv,
      CODEX_ROUTER_SYSTEMCTL_BIN: process.execPath,
      CODEX_ROUTER_SYSTEMCTL_ARGS_JSON: JSON.stringify([systemctl]),
    };
    runService("service-linux.mjs", "linux", ["snapshot", linuxSnapshot], linuxEnv);
    writeFileSync(unit, "new systemd definition\n");
    writeFileSync(managerState, "stopped\n");
    writeFileSync(managerEnabled, "disabled\n");
    runService("service-linux.mjs", "linux", ["restore", linuxSnapshot], linuxEnv);
    assert.equal(readFileSync(unit, "utf8"), "old systemd definition\n");
    assert.equal(readFileSync(managerState, "utf8"), "running\n");
    assert.equal(readFileSync(managerEnabled, "utf8"), "enabled\n");

    // Task Scheduler XML, wrapper/launcher bytes, and running state.
    const stateDir = path.join(testRoot, "codex router state");
    const wrapper = path.join(stateDir, "start-codex-router.cmd");
    const launcher = path.join(stateDir, "start-codex-router-hidden.vbs");
    const windowsSnapshot = path.join(testRoot, "windows-service.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(wrapper, "old wrapper\n");
    writeFileSync(launcher, "old launcher\n");
    writeFileSync(taskXml, "<Task>old</Task>\n");
    writeFileSync(taskPresent, "yes\n");
    writeFileSync(managerState, "running\n");
    const windowsEnv = {
      ...commonEnv,
      CODEX_ROUTER_SCHTASKS_BIN: process.execPath,
      CODEX_ROUTER_SCHTASKS_ARGS_JSON: JSON.stringify([schtasks]),
      CODEX_ROUTER_TASK_STATE_BIN: process.execPath,
      CODEX_ROUTER_TASK_STATE_ARGS_JSON: JSON.stringify([taskState]),
    };
    runService("service-windows.mjs", "win32", ["snapshot", windowsSnapshot], windowsEnv);
    writeFileSync(wrapper, "new wrapper\n");
    writeFileSync(launcher, "new launcher\n");
    writeFileSync(taskXml, "<Task>new</Task>\n");
    writeFileSync(managerState, "ready\n");
    runService("service-windows.mjs", "win32", ["restore", windowsSnapshot], windowsEnv);
    assert.equal(readFileSync(wrapper, "utf8"), "old wrapper\n");
    assert.equal(readFileSync(launcher, "utf8"), "old launcher\n");
    assert.equal(readFileSync(taskXml, "utf8"), "<Task>old</Task>\n");
    assert.equal(readFileSync(managerState, "utf8"), "running\n");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows launcher starts the wrapper hidden and propagates its exit code", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-launcher-"));
  try {
    const stateDir = windowsStateDir(testRoot);
    assert.ok(stateDir.includes(" "), "the fixture state directory must contain a space");
    const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
    const script = serviceCommand("service-windows.mjs", "win32", testRoot, "render-launcher");

    assert.match(script, /^Option Explicit\r\n/);
    assert.match(script, /\r\nSet shell = CreateObject\("WScript\.Shell"\)\r\n/);
    // Window style 0 hides the wrapper's console; True waits for it so that
    // Run returns the wrapper's exit code instead of returning immediately.
    assert.ok(
      script.includes(
        `status = shell.Run("cmd.exe /D /C " & quote & quote & "${wrapperPath}" & quote & quote, 0, True)\r\n`,
      ),
      `launcher did not embed the wrapper path correctly:\n${script}`,
    );
    // Without this line Task Scheduler reads every crash as a clean exit and
    // the RestartCount/RestartInterval settings never fire again.
    assert.match(script, /\r\nWScript\.Quit status\r\n$/);
    // A failure to even start the wrapper must also surface as a failure.
    assert.match(script, /\r\nIf Err\.Number <> 0 Then\r\n {2}WScript\.Quit 1\r\nEnd If\r\n/);

    // Every generated line must be a valid VBScript statement: string literals
    // escape a double quote by doubling it, so quotes always come in pairs.
    for (const line of script.split("\r\n")) {
      assert.equal(
        (line.match(/"/g) || []).length % 2,
        0,
        `unbalanced quotes in generated line: ${line}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows scheduled task runs the VBS launcher through wscript.exe", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-action-"));
  try {
    const launcherPath = path.join(windowsStateDir(testRoot), "start-codex-router-hidden.vbs");
    const action = JSON.parse(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-task"),
    );

    assert.equal(action.execute, "wscript.exe");
    // //B and //NoLogo keep the windowless host quiet; the launcher path takes a
    // single quote pair because wscript.exe uses the standard argument parser.
    assert.equal(action.argument, `//B //NoLogo "${launcherPath}"`);
    // The console-visible cmd.exe action is what issue #98 reported.
    assert.doesNotMatch(`${action.execute} ${action.argument}`, /cmd\.exe/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// The scheduled task's restart policy is the reason the exit code matters:
// Task Scheduler only re-triggers RestartCount/RestartInterval when the action
// reports a failure, so a launcher that swallowed the wrapper's exit code would
// trade a console window for a router that stays dead after its first crash.
// Nothing off Windows can execute a .vbs, so -- exactly like
// `install.ps1 parses under powershell.exe` in test/installer-scripts.test.mjs --
// this is the only place that link is executed rather than reasoned about.
//
// wscript.exe with //B //NoLogo is the host the scheduled task actually uses
// (see taskAction in src/service-windows.mjs). cscript.exe is the console host
// over the same script engine, and it runs without //B so that a broken
// launcher reports the parse or runtime error on stderr instead of arriving as
// an unexplained exit code.
const WINDOWS_SCRIPT_HOSTS = [
  { name: "cscript.exe", args: ["//NoLogo"] },
  { name: "wscript.exe", args: ["//B", "//NoLogo"] },
];

// Resolved absolutely: these live in the system directory, and naming them
// outright keeps the test independent of whatever PATH the runner supplies.
function scriptHost(name) {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

test(
  "the generated Windows launcher returns the wrapper's exit code to its script host",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-vbs-exit-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      mkdirSync(stateDir, { recursive: true });
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");

      // The shipped generator produces the source. Only the encoding is
      // repeated here: `install` is the code path that writes the file, and
      // running it would register a real scheduled task on this machine.
      // `the Windows installer writes both launchers idempotently` asserts that
      // the shipped writer emits exactly these bytes.
      const source = serviceCommand(
        "service-windows.mjs",
        "win32",
        testRoot,
        "render-launcher",
      );
      const encoded = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]);
      writeFileSync(launcherPath, encoded);

      const report = (host, result, expectation, note) =>
        [
          `host: ${host.name} ${host.args.join(" ")} "${launcherPath}"`,
          `expected exit code: ${expectation}`,
          `actual exit code: ${result.status}`,
          `terminating signal: ${result.signal ?? "none"}`,
          `spawn error: ${result.error ? result.error.message : "none"}`,
          `stdout: ${(result.stdout || "").trim() || "(empty)"}`,
          `stderr: ${(result.stderr || "").trim() || "(empty)"}`,
          note,
          "generated launcher source:",
          source,
        ].join("\n");

      const runLauncher = (host) => {
        const result = spawnSync(scriptHost(host.name), [...host.args, launcherPath], {
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        });
        // A spawn failure or a timeout leaves status null, which would satisfy
        // the "not zero" assertion below without the launcher having run at all.
        assert.equal(
          typeof result.status,
          "number",
          report(host, result, "any number", "the script host did not run to completion"),
        );
        return result;
      };

      for (const host of WINDOWS_SCRIPT_HOSTS) {
        // A crashed router has to reach Task Scheduler as a failed run. 42 is
        // arbitrary and distinctive: it is neither the 1 a WSH script error
        // produces nor the 0 a silent success would.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 42\r\n");
        let result = runLauncher(host);
        assert.equal(
          result.status,
          42,
          report(host, result, 42, "the wrapper's exit code must reach the host unchanged"),
        );

        // ...and the reverse: a clean stop must not be reported as a failure,
        // or the task restarts a router that was deliberately shut down.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 0\r\n");
        result = runLauncher(host);
        assert.equal(
          result.status,
          0,
          report(host, result, 0, "a clean wrapper exit must not be reported as a failure"),
        );

        // A wrapper that cannot start at all must still fail. `On Error Resume
        // Next` without the Err.Number guard leaves `status` unset, and
        // `WScript.Quit` on an unset value exits 0 -- which is the shape that
        // silently disables the restart policy. cmd.exe itself reports this
        // particular failure; the Err.Number branch covers a cmd.exe that will
        // not start, which no ordinary host can reproduce because CreateProcess
        // resolves it from the system directory whatever PATH says.
        rmSync(wrapperPath);
        result = runLauncher(host);
        assert.notEqual(
          result.status,
          0,
          report(host, result, "anything but 0", "a wrapper that never ran must not report success"),
        );
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows installer writes both launchers idempotently and uninstall removes both",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-install-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");
      const run = (command) =>
        JSON.parse(serviceCommand("service-windows.mjs", "win32", testRoot, command));

      // schtasks.exe and powershell.exe are absent off Windows, and every call
      // to them is best effort, so only the generated files are exercised here.
      assert.equal(run("install").installed, true);
      assert.equal(existsSync(wrapperPath), true);
      assert.equal(existsSync(launcherPath), true);

      const bytes = readFileSync(launcherPath);
      // wscript.exe falls back to the ANSI code page without this byte order
      // mark, which corrupts a state directory holding non-ASCII characters.
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
      assert.match(bytes.toString("utf16le").slice(1), /^Option Explicit\r\n/);

      // Reinstalling over an existing pair overwrites instead of failing.
      assert.equal(run("install").installed, true);
      assert.equal(readFileSync(launcherPath).equals(bytes), true);

      assert.equal(run("uninstall").installed, false);
      assert.equal(existsSync(wrapperPath), false);
      assert.equal(existsSync(launcherPath), false);

      // Uninstalling again must not fail on the already-removed launchers.
      assert.equal(run("uninstall").installed, false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

// Off Windows there is no schtasks.exe or powershell.exe, so every scheduler
// call src/service-windows.mjs makes is a failure and the ordering between them
// is invisible. Executable stubs of those names, first on PATH, make the whole
// sequence observable and let one call be failed on demand -- which is the only
// way to reach the recovery path without a Windows box and a restricted shell.
// They can never shadow the real executables, because the tests that use them
// are skipped on win32.
function schedulerStubs(directory, options = {}) {
  const { schtasksFail = "", powershellFail = "", runningQueries = 0 } = options;
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "calls.log");
  const counterPath = path.join(directory, "state-queries");
  const preamble = (fail) =>
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      `for pattern in ${fail}; do`,
      '  case "$*" in *"$pattern"*) exit 1 ;; esac',
      "done",
    ].join("\n");

  writeFileSync(path.join(directory, "schtasks.exe"), `${preamble(schtasksFail)}\nexit 0\n`);
  // taskState() reads the task state off this process's stdout. The counter is
  // what lets a test say "report Running for the first N queries", so the stop
  // wait can be observed polling and then finishing.
  writeFileSync(
    path.join(directory, "powershell.exe"),
    [
      preamble(powershellFail),
      'case "$*" in',
      "  *Get-ScheduledTask*)",
      "    count=0",
      `    if [ -f "${counterPath}" ]; then count=$(cat "${counterPath}"); fi`,
      "    count=$((count + 1))",
      `    printf '%s' "$count" > "${counterPath}"`,
      `    if [ "$count" -le ${runningQueries} ]; then printf 'Running'; else printf 'Ready'; fi`,
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );

  for (const name of ["schtasks.exe", "powershell.exe"]) {
    chmodSync(path.join(directory, name), 0o755);
  }
  return {
    path: `${directory}${path.delimiter}${process.env.PATH}`,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

function runWindowsService(testRoot, command, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "service-windows.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...serviceEnv("win32", testRoot), ...extraEnv },
    },
  );
}

test(
  "a blocked registration restarts whichever task definition survived",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-recover-"));
    try {
      // Registration is blocked through both routes, the way a restricted or
      // non-elevated terminal blocks it. endTask() has already stopped the
      // running router by then, so returning here would trade a working install
      // for nothing at all -- the regression this guards.
      const stubs = schedulerStubs(path.join(testRoot, "survivor"), {
        schtasksFail: "/Create",
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, true);

      const calls = stubs.calls();
      const at = (needle) => calls.findIndex((line) => line.includes(needle));
      assert.ok(at("/End") >= 0, `no /End in:\n${calls.join("\n")}`);
      assert.ok(
        at("/End") < at("Register-ScheduledTask"),
        `the running instance must be ended before re-registering:\n${calls.join("\n")}`,
      );
      // The surviving definition is queried before it is started: /Run against
      // a name that failed to register recovers nothing and reports its own
      // error over the one that actually matters.
      assert.ok(
        at("/Create") < at("/Query") && at("/Query") < at("/Run"),
        `the recovery must query before it runs:\n${calls.join("\n")}`,
      );
      assert.equal(calls.filter((line) => line.includes("/Run")).length, 1);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a registration failure that leaves no task does not start one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-no-task-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "gone"), {
        schtasksFail: "/Create /Query",
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      // Still best effort: the launchers are written and the caller retries.
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, true);

      const calls = stubs.calls();
      assert.ok(calls.some((line) => line.includes("/Query")));
      assert.equal(
        calls.some((line) => line.includes("/Run")),
        false,
        `nothing survived to start, so /Run must not be issued:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "install waits for the ended instance before starting the new one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-wait-"));
    try {
      // schtasks /End returns before the instance is gone. Reporting Running
      // for the first two state queries reproduces that window; a /Run issued
      // inside it is dropped by MultipleInstances IgnoreNew.
      const stubs = schedulerStubs(path.join(testRoot, "winding-down"), {
        runningQueries: 2,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.equal(
        states.length,
        3,
        `the wait must poll until the state leaves Running:\n${calls.join("\n")}`,
      );
      const lastState = calls.findLastIndex((line) => line.includes("Get-ScheduledTask"));
      assert.ok(
        lastState < calls.findIndex((line) => line.includes("/Run")),
        `the new instance must start after the old one has gone:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "an instance that never stops cannot hang the install",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stuck-"));
    try {
      // The state never leaves Running, so only the deadline can end the wait.
      // Without it install would block forever and take the installer with it.
      const stubs = schedulerStubs(path.join(testRoot, "stuck"), {
        runningQueries: 1_000_000,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.ok(states.length > 1, "the wait must have polled more than once");
      assert.ok(
        states.length < 500,
        `the wait must be bounded, not merely slow: ${states.length} state queries`,
      );
      // Giving up is not giving in: the install still registers and starts the
      // task, and the readiness check downstream is what reports a router that
      // never came back.
      assert.ok(calls.some((line) => line.includes("/Run")));
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "stopping a service that was never installed is not an error",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-"));
    try {
      // No stubs on PATH, so schtasks.exe is missing exactly as it is when the
      // task does not exist. stop used to throw that straight at the caller
      // while uninstall and restart tolerated it.
      const result = runWindowsService(testRoot, "stop");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
