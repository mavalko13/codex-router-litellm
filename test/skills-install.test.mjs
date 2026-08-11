import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import {
  installedSkillsFresh,
  installSkills,
  managedSkillNames,
  packSkillNames,
  skillOwnershipPath,
  skillPackStatus,
  skillRequiredFields,
  uninstallSkills,
} from "../src/skills-install.mjs";

// The repo's skill pack, installed into a throwaway codex home.
const PACK = [
  "codex-router",
  "codex-app-threads",
  "codex-in-app-browser",
  "codex-computer-use",
];
const SKILL_FRONTMATTER = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---\r?\n/;

function tempCodexHome() {
  return mkdtempSync(path.join(os.tmpdir(), "codex-skills-"));
}

function ownership(home) {
  return JSON.parse(readFileSync(skillOwnershipPath(home), "utf8"));
}

function marker(home, name) {
  return JSON.parse(
    readFileSync(path.join(home, "skills", name, ".codex-router-managed"), "utf8"),
  );
}

test("install copies every pack skill with its SKILL.md and the marker", () => {
  const home = tempCodexHome();
  try {
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 0);
    assert.equal(installed, PACK.length);
    for (const name of PACK) {
      const dir = path.join(home, "skills", name);
      assert.ok(existsSync(path.join(dir, "SKILL.md")), `${name}/SKILL.md installed`);
      const marker = path.join(dir, ".codex-router-managed");
      assert.ok(existsSync(marker), `${name} marker present`);
      const parsed = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(parsed.version, 1);
      assert.equal(parsed.name, name);
      assert.match(parsed.token, /^[a-f0-9]{64}$/);
      assert.equal(typeof parsed.source.packageVersion, "string");
      assert.equal(typeof parsed.source.commit, "string");
    }
    const state = ownership(home);
    assert.equal(state.version, 1);
    for (const name of PACK) assert.equal(state.skills[name].token, marker(home, name).token);
    if (process.platform !== "win32") {
      assert.equal(statSync(skillOwnershipPath(home)).mode & 0o777, 0o600);
    }
    assert.deepEqual(managedSkillNames(home).sort(), [...PACK].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install is idempotent and refreshes managed skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const first = readdirSync(path.join(home, "skills")).sort();
    const { installed } = installSkills(home, { quiet: true });
    assert.equal(installed, PACK.length);
    assert.deepEqual(readdirSync(path.join(home, "skills")).sort(), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install never clobbers a skill the user owns", () => {
  const home = tempCodexHome();
  try {
    mkdirSync(path.join(home, "skills", "codex-app-threads"), { recursive: true });
    writeFileSync(
      path.join(home, "skills", "codex-app-threads", "SKILL.md"),
      "# user's own skill\n",
    );
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 1);
    assert.equal(installed, PACK.length - 1);
    // The user's file is untouched; no marker was added.
    assert.equal(
      readFileSync(path.join(home, "skills", "codex-app-threads", "SKILL.md"), "utf8"),
      "# user's own skill\n",
    );
    assert.ok(
      !existsSync(path.join(home, "skills", "codex-app-threads", ".codex-router-managed")),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an arbitrary or legacy marker never grants ownership", () => {
  const home = tempCodexHome();
  try {
    const dir = path.join(home, "skills", "codex-app-threads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# user's marked skill\n");
    writeFileSync(path.join(dir, ".codex-router-managed"), "x\n");
    const result = installSkills(home, { quiet: true });
    assert.equal(result.skipped, 1);
    assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# user's marked skill\n");
    assert.ok(!managedSkillNames(home).includes("codex-app-threads"));
    uninstallSkills(home, { quiet: true });
    assert.ok(existsSync(dir), "marker-only directory preserved by uninstall");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a valid-looking marker without matching private state is still user-owned", () => {
  const home = tempCodexHome();
  try {
    const dir = path.join(home, "skills", "codex-router");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# mine\n");
    writeFileSync(
      path.join(dir, ".codex-router-managed"),
      `${JSON.stringify({
        version: 1,
        name: "codex-router",
        token: "a".repeat(64),
        source: { packageVersion: "1.0.0", commit: "deadbeef" },
      })}\n`,
    );
    assert.equal(installSkills(home, { quiet: true }).skipped, 1);
    assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes exactly the managed skills, never user skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // A decoy user skill that happens to share the pack's naming space.
    mkdirSync(path.join(home, "skills", "user-custom-skill"), { recursive: true });
    writeFileSync(path.join(home, "skills", "user-custom-skill", "SKILL.md"), "# mine\n");
    const removed = uninstallSkills(home, { quiet: true });
    assert.equal(removed, PACK.length);
    assert.ok(!existsSync(path.join(home, "skills", "codex-router")));
    assert.ok(!existsSync(path.join(home, "skills", "codex-app-threads")));
    // The user's skill survives.
    assert.ok(existsSync(path.join(home, "skills", "user-custom-skill")));
    assert.deepEqual(managedSkillNames(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall on a clean home is a no-op", () => {
  const home = tempCodexHome();
  try {
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.equal(installSkills(home, { quiet: true }).installed, PACK.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install prunes stale managed dirs the pack no longer ships", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // Simulate a pack skill being removed in a later revision: plant a
    // managed dir that no longer exists in the source.
    const stale = path.join(home, "skills", "codex-obsolete");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "SKILL.md"), "# obsolete\n");
    const state = ownership(home);
    const token = "b".repeat(64);
    state.skills["codex-obsolete"] = { token };
    writeFileSync(skillOwnershipPath(home), `${JSON.stringify(state, null, 2)}\n`);
    const source = marker(home, "codex-router").source;
    writeFileSync(
      path.join(stale, ".codex-router-managed"),
      `${JSON.stringify({ version: 1, name: "codex-obsolete", token, source }, null, 2)}\n`,
    );
    installSkills(home, { quiet: true });
    assert.ok(!existsSync(stale), "stale managed dir removed");
    assert.ok(existsSync(path.join(home, "skills", "codex-router")), "current skills kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("state and marker mismatch preserves the directory and clears ownership", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const name = "codex-router";
    const dir = path.join(home, "skills", name);
    const parsed = marker(home, name);
    parsed.token = "c".repeat(64);
    writeFileSync(path.join(dir, ".codex-router-managed"), `${JSON.stringify(parsed)}\n`);
    assert.ok(skillPackStatus(home).staleOwnership.includes(name));
    assert.equal(uninstallSkills(home, { quiet: true }), PACK.length - 1);
    assert.ok(existsSync(dir), "mismatched target preserved");
    assert.deepEqual(managedSkillNames(home), []);
    assert.ok(!ownership(home).skills[name], "stale private record cleared");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a regular-file collision is preserved and status never throws", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const collision = path.join(home, "skills", "codex-router");
    rmSync(collision, { recursive: true, force: true });
    writeFileSync(collision, "user file\n");
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(installed, PACK.length - 1);
    assert.equal(skipped, 1);
    assert.equal(readFileSync(collision, "utf8"), "user file\n");
    const status = skillPackStatus(home);
    assert.ok(status.collisions.includes("codex-router"));
    assert.ok(status.missing.includes("codex-router"));
    assert.ok(!ownership(home).skills["codex-router"], "stale state entry cleared");
    const freshness = installedSkillsFresh(home);
    assert.equal(freshness.fresh, false);
    assert.ok(freshness.stale.includes("codex-router"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "a symlink collision is preserved",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    const userDir = mkdtempSync(path.join(os.tmpdir(), "codex-user-skill-"));
    try {
      installSkills(home, { quiet: true });
      writeFileSync(path.join(userDir, "SKILL.md"), "# mine\n");
      const collision = path.join(home, "skills", "codex-router");
      rmSync(collision, { recursive: true, force: true });
      symlinkSync(userDir, collision, "dir");
      assert.equal(installSkills(home, { quiet: true }).skipped, 1);
      assert.equal(readFileSync(path.join(userDir, "SKILL.md"), "utf8"), "# mine\n");
      assert.ok(!ownership(home).skills["codex-router"], "stale state entry cleared");
      uninstallSkills(home, { quiet: true });
      assert.ok(existsSync(collision), "symlink remains after uninstall");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  },
);

test("corrupt private ownership state fails closed", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    writeFileSync(skillOwnershipPath(home), "{not json\n");
    const status = skillPackStatus(home);
    assert.equal(status.ownershipStateValid, false);
    assert.deepEqual(status.managed, []);
    assert.deepEqual(status.collisions, [...PACK].sort());
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) {
      assert.ok(existsSync(path.join(home, "skills", name)), `${name} preserved`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one malformed ownership record invalidates the whole state file", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const state = ownership(home);
    state.skills.invalid = { token: "short" };
    writeFileSync(skillOwnershipPath(home), `${JSON.stringify(state)}\n`);
    const status = skillPackStatus(home);
    assert.equal(status.ownershipStateValid, false);
    assert.deepEqual(status.managed, []);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "an ownership file with public permissions fails closed",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    try {
      installSkills(home, { quiet: true });
      chmodSync(skillOwnershipPath(home), 0o644);
      const status = skillPackStatus(home);
      assert.equal(status.ownershipStateValid, false);
      assert.deepEqual(status.managed, []);
      assert.deepEqual(status.missing, [...PACK].sort());
      assert.equal(uninstallSkills(home, { quiet: true }), 0);
      for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("install skips hidden directories and dirs without SKILL.md", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    // A hidden dir and a non-skill dir in the source must never be copied.
    mkdirSync(path.join(fakeSource, ".hidden"), { recursive: true });
    mkdirSync(path.join(fakeSource, "no-skill-dir"), { recursive: true });
    for (const name of PACK) {
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), `# ${name}\n`);
    }
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    try {
      const { installed } = installSkills(home, { quiet: true });
      assert.equal(installed, PACK.length);
      const installedNames = readdirSync(path.join(home, "skills")).sort();
      assert.ok(!installedNames.includes(".hidden"), "hidden dir not copied");
      assert.ok(!installedNames.includes("no-skill-dir"), "no-SKILL.md dir not copied");
    } finally {
      delete process.env.CODEX_ROUTER_SKILLS_DIR;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("packSkillNames lists exactly the shipped pack", () => {
  const names = packSkillNames();
  assert.deepEqual(names, [...PACK].sort());
});

test("installedSkillsFresh is true after install and false after a manual edit", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    assert.deepEqual(installedSkillsFresh(home), { fresh: true, stale: [] });
    // A user edits a managed skill: freshness must flag it.
    const target = path.join(home, "skills", "codex-app-threads", "SKILL.md");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n# local edit\n`);
    const { fresh, stale } = installedSkillsFresh(home);
    assert.equal(fresh, false);
    assert.ok(stale.includes("codex-app-threads"));
    // Re-install restores freshness.
    installSkills(home, { quiet: true });
    assert.equal(installedSkillsFresh(home).fresh, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "installedSkillsFresh rejects an identical-content symlinked skill file",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    const external = path.join(home, "external-skill.md");
    try {
      installSkills(home, { quiet: true });
      const target = path.join(home, "skills", "codex-router", "SKILL.md");
      writeFileSync(external, readFileSync(target, "utf8"));
      rmSync(target);
      symlinkSync(external, target, "file");

      const { fresh, stale } = installedSkillsFresh(home);
      assert.equal(fresh, false);
      assert.ok(stale.includes("codex-router"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("freshness includes unexpected hidden files but ignores only the ownership marker", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const dir = path.join(home, "skills", "codex-router");
    writeFileSync(path.join(dir, ".unexpected"), "drift\n");
    assert.equal(installedSkillsFresh(home).fresh, false);
    rmSync(path.join(dir, ".unexpected"));
    writeFileSync(path.join(dir, ".codex-router-managed"), "changed marker only\n");
    assert.equal(installedSkillsFresh(home).fresh, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installedSkillsFresh flags a missing managed skill", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    rmSync(path.join(home, "skills", "codex-router"), { recursive: true, force: true });
    const { fresh, stale } = installedSkillsFresh(home);
    assert.equal(fresh, false);
    assert.ok(stale.includes("codex-router"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the skill's declared required fields match the app snapshot", () => {
  const codexApp = CODEX_APP_TOOLS.find((entry) => entry.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present in snapshot");
  const byName = new Map(codexApp.tools.map((fn) => [fn.name, fn]));
  const expected = skillRequiredFields();
  assert.deepEqual(expected, {
    create_thread: ["prompt", "target"],
    read_thread: ["threadId"],
    send_message_to_thread: ["threadId", "prompt"],
  });
  for (const [name, want] of Object.entries(expected)) {
    const fn = byName.get(name);
    assert.ok(fn, `snapshot carries ${name}`);
    assert.deepEqual(
      [...(fn.inputSchema?.required || [])].sort(),
      [...want].sort(),
      `${name} required fields match the skill pack`,
    );
  }
  // The skills text must actually say create_thread needs prompt AND target.
  const threadsSkill = readFileSync(
    path.join(skillsRoot(), "codex-app-threads", "SKILL.md"),
    "utf8",
  );
  assert.match(threadsSkill, /requires TWO fields: `prompt` \(string\) and `target`/);
});

test("a missing or malformed skill contract is reported as unavailable", () => {
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const dir = path.join(fakeSource, "codex-app-threads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# no contract\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    assert.equal(skillRequiredFields(), undefined);
    writeFileSync(
      path.join(dir, "SKILL.md"),
      '<!-- codex-router-required-fields: {"create_thread":"prompt"} -->\n',
    );
    assert.equal(skillRequiredFields(), undefined);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

function skillsRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

test("skill frontmatter accepts LF and CRLF checkouts", () => {
  const lf = "---\nname: example\ndescription: Use when testing.\n---\n";
  assert.ok(SKILL_FRONTMATTER.exec(lf));
  assert.ok(SKILL_FRONTMATTER.exec(lf.replaceAll("\n", "\r\n")));
});

test("every pack skill has valid frontmatter, a trigger description, and stays short", () => {
  const skillsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
  );
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(skillsRoot, e.name, "SKILL.md")))
    .map((e) => e.name);
  assert.ok(names.length >= 4, `pack has at least the 4 core skills, got ${names.length}`);
  for (const name of names) {
    const text = readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    // Frontmatter parses: name matches the directory, description present.
    const match = SKILL_FRONTMATTER.exec(text);
    assert.ok(match, `${name}: valid frontmatter`);
    assert.equal(match[1], name, `${name}: frontmatter name matches directory`);
    // The description is what the model matches on; it must carry triggers.
    assert.match(match[2], /Use when/, `${name}: description has "Use when" triggers`);
    // Every description is scoped to custom routed models so a native GPT
    // session never triggers a skill that teaches flattened names it lacks.
    assert.match(
      match[2],
      /custom \(non-OpenAI\) model/,
      `${name}: description scoped to custom models`,
    );
    assert.ok(match[2].length <= 1024, `${name}: description within 1024 chars`);
    // Keep the pack cheap to load: short file, no emoji, no time-sensitive data.
    assert.ok(text.split("\n").length <= 100, `${name}: SKILL.md under 100 lines`);
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji`);
    assert.doesNotMatch(text, /20\d\d-\d\d-\d\d/, `${name}: no hardcoded dates`);
  }
});
