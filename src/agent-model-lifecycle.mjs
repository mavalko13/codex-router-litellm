import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { protectPrivateFile } from "./file-security.mjs";
import { CODEX_AGENTS_DIR, CONFIG_PATH } from "./paths.mjs";

// Router-generated definitions have their own catalog lifecycle. This module
// intentionally considers only the named role files alongside them.
const ROUTER_MODEL_FILE = /^router-model-[a-z0-9-]+\.toml$/;

function tomlStringValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const value = JSON.parse(raw);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return undefined;
}

function simpleTomlKey(raw) {
  const token = raw.trim();
  if (/^[A-Za-z0-9_-]+$/.test(token)) return token;
  return tomlStringValue(token);
}

function simpleKeyPattern(key) {
  return `(?:${key}|[\\\"']${key}[\\\"'])`;
}

function assignment(contents, key, { agentsTable = false } = {}) {
  const lines = contents.split(/(?<=\n)/);
  let inAgentsTable = !agentsTable;
  let offset = 0;
  for (const line of lines) {
    const body = line.replace(/\r?\n$/, "");
    const table = body.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) inAgentsTable = simpleTomlKey(table[1]) === "agents";
    const match = inAgentsTable
      ? body.match(new RegExp(`^(\\s*${key}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(\\s*(?:#.*)?)$`))
      : undefined;
    if (match) {
      const value = tomlStringValue(match[2]);
      if (value !== undefined) {
        return { value, start: offset + match[1].length, end: offset + match[1].length + match[2].length };
      }
    }
    offset += line.length;
  }
  return undefined;
}

function rootAssignment(contents, key) {
  const firstTable = contents.search(/^\s*\[/m);
  return assignment(
    firstTable === -1 ? contents : contents.slice(0, firstTable),
    simpleKeyPattern(key),
  );
}

function rootDefaultSubagentAssignment(contents) {
  const firstTable = contents.search(/^\s*\[/m);
  const root = firstTable === -1 ? contents : contents.slice(0, firstTable);
  return assignment(
    root,
    "(?:agents\\s*\\.\\s*default_subagent_model|[\\\"']agents[\\\"']\\s*\\.\\s*default_subagent_model|agents\\s*\\.\\s*[\\\"']default_subagent_model[\\\"']|[\\\"']agents[\\\"']\\s*\\.\\s*[\\\"']default_subagent_model[\\\"'])",
  );
}

export function resolveAgentModelSuccessor(reference, availableSlugs) {
  const candidate = `${reference}-no-fallback`;
  const matches = [...availableSlugs].filter((slug) => slug === candidate);
  return matches.length === 1 ? candidate : undefined;
}

function regularFileMode(target) {
  try {
    const metadata = lstatSync(target);
    return metadata.isFile() ? metadata.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

function atomicReplace(target, contents, replacement, mode) {
  const next = `${contents.slice(0, replacement.start)}${JSON.stringify(replacement.value)}${contents.slice(replacement.end)}`;
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, next, { encoding: "utf8", mode });
  try {
    protectPrivateFile(temporary);
    // Do not turn an operator-owned symlink (or another special file) into a
    // regular file during repair. Recheck immediately before the rename too.
    if (regularFileMode(target) === undefined) {
      throw new Error("Refusing to replace a non-regular agent configuration file.");
    }
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function referenceResult({
  target,
  reference,
  assignment: entry,
  available,
  repairable,
  repair,
  contents,
}) {
  const base = { path: target, reference, candidates: [] };
  if (available.has(reference)) return { ...base, status: "valid" };
  const candidates = [...available].filter((slug) => slug === `${reference}-no-fallback`);
  const successor = resolveAgentModelSuccessor(reference, available);
  if (!repair || !repairable || !successor || !entry) {
    return { ...base, status: "unresolved", candidates };
  }
  try {
    const mode = regularFileMode(target);
    if (mode === undefined) return { ...base, status: "unresolved", candidates };
    atomicReplace(target, contents, { ...entry, value: successor }, mode);
    return { ...base, status: "repaired", replacement: successor, candidates };
  } catch {
    return { ...base, status: "unresolved", candidates };
  }
}

function inspectFileReference({
  target,
  parse,
  available,
  repairable,
  repair,
}) {
  let release;
  try {
    // Never open a symlink, FIFO, socket, or directory. In particular, opening
    // a FIFO would block a refresh before it had a chance to report the drift.
    if (regularFileMode(target) === undefined) {
      return { path: target, reference: "<non-regular>", candidates: [], status: "unresolved" };
    }
    if (repair) {
      release = lockfile.lockSync(target, {
        realpath: false,
        stale: 90_000,
        update: 10_000,
        retries: 0,
      });
    }
    // Parse after the lock is held. A background catalog refresh must never
    // apply offsets calculated before an operator's concurrent manual edit.
    const contents = readFileSync(target, "utf8");
    if (regularFileMode(target) === undefined) {
      return { path: target, reference: "<non-regular>", candidates: [], status: "unresolved" };
    }
    const parsed = parse(contents);
    if (!parsed) return undefined;
    return referenceResult({
      target,
      reference: parsed.entry.value,
      assignment: parsed.entry,
      available,
      repairable: parsed.repairable ?? repairable,
      repair,
      contents,
    });
  } catch {
    return {
      path: target,
      reference: "<unreadable>",
      candidates: [],
      status: "unresolved",
    };
  } finally {
    if (release) release();
  }
}

function agentFiles(agentsDir) {
  try {
    return readdirSync(agentsDir)
      .filter((entry) => entry.endsWith(".toml") && !ROUTER_MODEL_FILE.test(entry))
      .map((entry) => path.join(agentsDir, entry));
  } catch {
    return [];
  }
}

// Checks the default and explicit role references against the exact catalog
// just written. Only an exact same-provider `-no-fallback` successor is safe
// to select automatically; all other drift remains visible to the operator.
function availableSlugs(availableModels) {
  return new Set(
    [...availableModels]
      .map((model) => typeof model === "string" ? model : model?.slug)
      .map((slug) => String(slug || "").trim())
      .filter(Boolean),
  );
}

function defaultSubagentSlugs(availableModels) {
  return new Set(
    [...availableModels]
      .filter((model) =>
        typeof model !== "string" &&
        model?.visibility === "list" &&
        model?.multi_agent_version === "v2",
      )
      .map((model) => String(model.slug || "").trim())
      .filter(Boolean),
  );
}

function inspectCodexAgentModelReferences({
  availableModels,
  repair = false,
  configPath = CONFIG_PATH,
  agentsDir = CODEX_AGENTS_DIR,
} = {}) {
  const models = availableModels || [];
  const available = availableSlugs(models);
  const defaultAvailable = defaultSubagentSlugs(models);
  const records = [];
  if (existsSync(configPath)) {
    const result = inspectFileReference({
      target: configPath,
      parse: (contents) => {
        const entry =
          rootDefaultSubagentAssignment(contents) ||
          assignment(contents, simpleKeyPattern("default_subagent_model"), { agentsTable: true });
        return entry ? { entry, repairable: true } : undefined;
      },
      available: defaultAvailable,
      repairable: true,
      repair,
    });
    if (result) records.push(result);
  }
  for (const target of agentFiles(agentsDir)) {
    const result = inspectFileReference({
      target,
      parse: (contents) => {
        const model = rootAssignment(contents, "model");
        if (!model) return undefined;
        const provider = rootAssignment(contents, "model_provider");
        return { entry: model, repairable: provider?.value === "codex-router" };
      },
      available,
      repairable: undefined,
      repair,
    });
    if (!result) continue;
    records.push(result);
  }
  return {
    valid: records.filter(({ status }) => status === "valid"),
    repaired: records.filter(({ status }) => status === "repaired"),
    unresolved: records.filter(({ status }) => status === "unresolved"),
    ok: records.every(({ status }) => status !== "unresolved"),
  };
}

export function reconcileCodexAgentModelReferences(options = {}) {
  return inspectCodexAgentModelReferences({ ...options, repair: true });
}

export function codexAgentModelReferenceStatus(options = {}) {
  return inspectCodexAgentModelReferences({ ...options, repair: false });
}
