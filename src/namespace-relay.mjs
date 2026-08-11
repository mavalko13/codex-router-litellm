import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// The Codex client ships most of its toolset as `type: "namespace"` entries:
// the collaboration runtime, the app toolset (threads, automations,
// navigation), and every MCP server (node_repl, peekaboo, github, ...).
//
// LiteLLM's Responses -> Chat Completions bridge drops namespace tools, which
// is how the app sends all of those to the model. A routed chat-completions
// provider would therefore see none of them: no collaboration tools, no
// threads, and no `mcp__node_repl__js` -- the runtime the in-app browser and
// computer-use skills drive. This module is the one relay for all of it:
//
//   1. flattenNamespaceTools        -- namespace entries -> plain
//                                      `<namespace>__<tool>` functions the
//                                      provider accepts
//   2. flattenNamespacedHistory     -- stored calls renamed to the flattened
//                                      form so the model's transcript matches
//                                      its tool list
//   3. NamespaceToolCallTransform   -- function calls coming back restored to
//                                      the app's native `{name, namespace}`
//                                      shape so the client dispatches them
//
// The router only relays definitions and results; it never executes an app
// tool itself. Namespace names themselves may contain the delimiter
// (`mcp__codex_apps__github`), so restoration always resolves through the map
// built from the exact tools that were flattened -- never by splitting names.

export const NAMESPACE_DELIMITER = "__";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Codex uses `inputSchema` for native function definitions, including the
// functions nested under its namespace entries. OpenAI-compatible Responses
// endpoints use `parameters` instead. Keep this as a pure transform because
// the definitions supplied by the desktop are also retained locally for
// native dispatch; rewriting them in place would make a routed turn alter
// later native turns.
//
// The explicit `function` branch covers the Chat Completions wrapper as well
// as direct Responses functions. The `tools` branch permits nested namespaces
// without walking arbitrary schema objects, where an `inputSchema` field would
// be data rather than a tool-definition property.
export function normalizeToolSchemasForOpenAI(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const normalized = tools.map((tool) => {
    const next = normalizeToolSchemaForOpenAI(tool);
    if (next !== tool) changed = true;
    return next;
  });
  return changed ? normalized : tools;
}

function normalizeToolSchemaForOpenAI(tool) {
  if (!isRecord(tool)) return tool;
  let normalized = tool;

  const replace = (field, value) => {
    if (normalized === tool) normalized = { ...tool };
    normalized[field] = value;
  };

  if (Array.isArray(tool.tools)) {
    const nested = normalizeToolSchemasForOpenAI(tool.tools);
    if (nested !== tool.tools) replace("tools", nested);
  }
  if (isRecord(tool.function)) {
    const nested = normalizeToolSchemaForOpenAI(tool.function);
    if (nested !== tool.function) replace("function", nested);
  }
  if (Object.hasOwn(tool, "inputSchema")) {
    if (normalized === tool) normalized = { ...tool };
    // A provider-specific `parameters` value is authoritative, including an
    // intentionally empty schema. Only supply the Codex schema when absent.
    if (!Object.hasOwn(tool, "parameters")) normalized.parameters = tool.inputSchema;
    delete normalized.inputSchema;
  }
  return normalized;
}

// A fresh local thread inherits the routed session model when the caller did
// not choose one. Follow-up messages intentionally keep the target thread's
// settings, and cloud tasks require model omission, so neither is rewritten.
export const SPAWN_MODEL_TOOLS = new Set(["create_thread"]);
const SPAWN_TOOL_PREFIX = `codex_app${NAMESPACE_DELIMITER}`;

function isSpawnModelCall(item) {
  if (!item || typeof item.name !== "string") return false;
  // Flattened form the router sends to chat-completions bridges:
  // `codex_app__create_thread`.
  if (item.name.startsWith(SPAWN_TOOL_PREFIX)) {
    return SPAWN_MODEL_TOOLS.has(item.name.slice(SPAWN_TOOL_PREFIX.length));
  }
  // Native namespace form openai-responses providers keep:
  // `{ name: "create_thread", namespace: "codex_app" }`.
  if (item.namespace === "codex_app") return SPAWN_MODEL_TOOLS.has(item.name);
  return false;
}

// Inject the session model into local create_thread calls that omitted it.
// `model` is the routed session's model (route.slug). Returns a rewritten
// item when the call is one of SPAWN_MODEL_TOOLS, carries no explicit model,
// and a session model is available; otherwise returns the item untouched.
export function injectSessionModelForSpawnCalls(item, model) {
  if (!isSpawnModelCall(item)) return item;
  if (typeof model !== "string" || !model) return item;
  if (typeof item.arguments !== "string") return item;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return item;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return item;
  if (args.model !== undefined) return item;
  if (args.target?.type === "chatgptWorkCloud") return item;
  return { ...item, arguments: JSON.stringify({ ...args, model }) };
}

const MAX_JSON_CAPTURE_BYTES = 64 * 1024 * 1024;
const SSE_FIELD_LINE = /^(?:event|data):/m;
const SSE_SNIFF_BYTES = 512;

// Flatten every namespace entry into plain functions named
// `<namespace>__<tool>`. Returns the set of namespaces that were flattened
// (name -> tool names) so callers can rename history and restore calls.
export function flattenNamespaceTools(tools) {
  if (!Array.isArray(tools)) return { tools, flattened: false, namespaces: new Map() };
  const flattened = [];
  const namespaces = new Map();
  let changed = false;
  for (const tool of tools) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      const names = new Set();
      for (const fn of tool.tools) {
        if (!fn?.name) continue;
        flattened.push({
          ...fn,
          name: `${tool.name}${NAMESPACE_DELIMITER}${fn.name}`,
        });
        names.add(fn.name);
      }
      if (names.size > 0) {
        namespaces.set(tool.name, names);
        changed = true;
      }
      continue;
    }
    flattened.push(tool);
  }
  return { tools: flattened, flattened: changed, namespaces };
}

// Flattening only the tool list leaves the model reading two names for one
// tool: `collaboration__spawn_agent` in its tools, but a bare `spawn_agent`
// in its own call history, because LiteLLM's bridge drops the `namespace`
// field when it converts stored function calls to Chat Completions tool calls.
// The model imitates the history, emits the bare name, nothing rewrites it,
// and Codex answers `unsupported call` -- permanently, since every failure
// adds another bare example. Rename the history to match the flattened tools.
export function flattenNamespacedHistory(input, namespaces) {
  if (!Array.isArray(input) || namespaces.size === 0) return input;
  const flattenedNames = new Set();
  const bareOwners = new Map();
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      flattenedNames.add(`${namespace}${NAMESPACE_DELIMITER}${name}`);
      if (!bareOwners.has(name)) bareOwners.set(name, new Set());
      bareOwners.get(name).add(namespace);
    }
  }
  return input.map((item) => {
    if (item?.type !== "function_call") return item;
    const { name } = item;
    if (typeof name !== "string") return item;
    // Already in the flattened form (the client stored the restored call).
    if (flattenedNames.has(name)) return item;
    // The client stores namespaced calls as { name, namespace }.
    const namespace = item.namespace;
    if (typeof namespace === "string" && namespaces.get(namespace)?.has(name)) {
      const { namespace: _namespace, ...rest } = item;
      return { ...rest, name: `${namespace}${NAMESPACE_DELIMITER}${name}` };
    }
    // Calls stored without a namespace field whose bare name belongs to
    // exactly one flattened namespace.
    if (namespace === undefined) {
      const owners = bareOwners.get(name);
      if (owners && owners.size === 1) {
        const [owner] = [...owners];
        const { namespace: _namespace, ...rest } = item;
        return { ...rest, name: `${owner}${NAMESPACE_DELIMITER}${name}` };
      }
    }
    return item;
  });
}

// Reverse lookups for restoring calls: flattened name -> native
// { namespace, name }, and bare tool name -> namespaces that own it.
export function buildNamespaceLookups(namespaces) {
  const flatToNative = new Map();
  const bareToNamespaces = new Map();
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      flatToNative.set(`${namespace}${NAMESPACE_DELIMITER}${name}`, {
        namespace,
        name,
      });
      if (!bareToNamespaces.has(name)) bareToNamespaces.set(name, new Set());
      bareToNamespaces.get(name).add(namespace);
    }
  }
  return { flatToNative, bareToNamespaces };
}

// Restore one SSE event's function call to the client's native namespace
// shape. A flattened `<namespace>__<tool>` name resolves exactly. A bare tool
// name (some models emit the unqualified form) is restored only when it is
// unambiguous across every flattened namespace; a collision stays untouched
// rather than guessing which runtime owns it.
function rewriteNamespaceFunctionCallItem(item, lookups, sessionModel) {
  if (!item || item.type !== "function_call") return undefined;
  let rewritten = item;
  const resolved = lookups.flatToNative.get(item.name);
  if (resolved) {
    rewritten = {
      ...item,
      name: resolved.name,
      namespace: resolved.namespace,
    };
  } else {
    const owners = lookups.bareToNamespaces.get(item.name);
    if (item.namespace === undefined && owners && owners.size === 1) {
      const [namespace] = [...owners];
      rewritten = {
        ...item,
        namespace,
      };
    }
  }
  rewritten = injectSessionModelForSpawnCalls(rewritten, sessionModel);
  return rewritten === item ? undefined : rewritten;
}

export function rewriteNamespaceFunctionCall(event, lookups, sessionModel) {
  const item = rewriteNamespaceFunctionCallItem(event?.item, lookups, sessionModel);
  return item ? { ...event, item } : undefined;
}

function rewriteOutputItems(output, lookups, sessionModel) {
  if (!Array.isArray(output)) return undefined;
  let changed = false;
  const rewritten = output.map((item) => {
    const next = rewriteNamespaceFunctionCallItem(item, lookups, sessionModel);
    if (!next) return item;
    changed = true;
    return next;
  });
  return changed ? rewritten : undefined;
}

// Non-streaming Responses return completed function calls in an `output`
// array instead of SSE `item` events. Restore both shapes through the same
// exact request-local lookup so stream mode cannot change dispatch semantics.
// Returns a copy only when at least one call was restored.
export function rewriteNamespaceResponsePayload(payload, lookups, sessionModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  let rewritten = rewriteNamespaceFunctionCall(payload, lookups, sessionModel) || payload;
  let changed = rewritten !== payload;

  const output = rewriteOutputItems(rewritten.output, lookups, sessionModel);
  if (output) {
    rewritten = { ...rewritten, output };
    changed = true;
  }

  const responseOutput = rewriteOutputItems(rewritten.response?.output, lookups, sessionModel);
  if (responseOutput) {
    rewritten = {
      ...rewritten,
      response: { ...rewritten.response, output: responseOutput },
    };
    changed = true;
  }
  return changed ? rewritten : undefined;
}

// Rewrites LiteLLM's flattened `<namespace>__<tool>` function calls back to
// the namespace + name shape Codex dispatches through its app runtime.
export class NamespaceToolCallTransform extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #pending = Buffer.alloc(0);
  #released = false;
  #undeclared;
  #lookups;
  #sessionModel;

  constructor(namespaces, contentType = "", sessionModel) {
    super();
    this.#lookups = buildNamespaceLookups(namespaces);
    this.#sessionModel = sessionModel;
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#undeclared = !this.#eventStream && !declared.includes("json");
  }

  _transform(chunk, _encoding, callback) {
    if (this.#undeclared && chunk.length) {
      this.#undeclared = false;
      this.#eventStream = SSE_FIELD_LINE.test(
        chunk.subarray(0, SSE_SNIFF_BYTES).toString("utf8"),
      );
    }
    if (!this.#eventStream) {
      if (this.#released) {
        this.push(chunk);
        callback();
        return;
      }
      this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
      if (this.#pending.length > MAX_JSON_CAPTURE_BYTES) {
        this.push(this.#pending);
        this.#pending = Buffer.alloc(0);
        this.#released = true;
      }
      callback();
      return;
    }
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteEvents();
    callback();
  }

  _flush(callback) {
    if (!this.#eventStream) {
      const body = this.#pending;
      this.#pending = Buffer.alloc(0);
      if (this.#released || !body.length) {
        if (body.length) this.push(body);
        callback();
        return;
      }
      try {
        const payload = JSON.parse(body.toString("utf8"));
        const rewritten = rewriteNamespaceResponsePayload(
          payload,
          this.#lookups,
          this.#sessionModel,
        );
        this.push(rewritten ? Buffer.from(JSON.stringify(rewritten), "utf8") : body);
      } catch {
        this.push(body);
      }
      callback();
      return;
    }
    this.#buffer += this.#decoder.end();
    this.#emitCompleteEvents(true);
    callback();
  }

  #emitCompleteEvents(flush = false) {
    const blocks = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = flush ? "" : blocks.pop() || "";
    for (const block of blocks) {
      this.push(Buffer.from(this.#rewriteBlock(block)));
      this.push(Buffer.from("\n\n"));
    }
  }

  #rewriteBlock(block) {
    const lines = block.split(/\r?\n/);
    const rewritten = [];
    let changed = false;
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        rewritten.push(line);
        continue;
      }
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") {
        rewritten.push(line);
        continue;
      }
      try {
        const event = JSON.parse(data);
        const next = rewriteNamespaceResponsePayload(event, this.#lookups, this.#sessionModel);
        if (!next) {
          rewritten.push(line);
          continue;
        }
        rewritten.push(`data: ${JSON.stringify(next)}`);
        changed = true;
      } catch {
        rewritten.push(line);
      }
    }
    return changed ? `${rewritten.join("\r\n")}\r\n` : block;
  }
}
