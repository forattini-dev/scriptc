import { activeRuntimeTarget } from "../compat/runtime-target.js";


/** The node builtin modules with scriptc lowerings, by CANONICAL (bare)
 * name — every module answers to both specifier forms ("fs" and "node:fs"
 * are the same module, like in Node). When the fallback declarations ship,
 * this is exactly the set of `declare module` names in that file; when
 * @types/node stands in (which declares ALL node builtins) the supported
 * surface must not widen, so preflight allowlists this same fixed set. */
export const SUPPORTED_BUILTIN_MODULES = ["fs", "path", "path/posix", "path/win32", "os", "url", "fs/promises", "crypto", "zlib", "child_process", "net", "http", "tls", "https", "dgram", "dns", "util", "util/types", "string_decoder", "querystring", "readline", "http2", "assert", "assert/strict", "worker_threads", "buffer", "cluster", "tty", "async_hooks", "events", "stream", "stream/promises", "stream/consumers", "test", "timers", "timers/promises", "diagnostics_channel", "perf_hooks", "module"] as const;

/** Builtins Node itself serves ONLY under the node: prefix —
 * require("test") is MODULE_NOT_FOUND in Node, so the bare name stays a
 * user-package specifier and never canonicalizes to the builtin. Bare
 * "module" is NOT in this set: Node serves the builtin for both spellings
 * (a builtin always wins over a same-named npm package for the bare
 * specifier — the npm package named "module" is unreachable in Node too),
 * so both spellings key the same lowering tables here. */
const PREFIX_ONLY_BUILTIN_MODULES: ReadonlySet<string> = new Set(["test"]);

/** The builtin modules whose DEFAULT import binding lowers: node:assert's
 * module object IS a callable function (`import assert from "node:assert";
 * assert(x)`), and node:events' module object IS the EventEmitter class
 * (`module.exports = EventEmitter` — `import EventEmitter from
 * "node:events"; new EventEmitter()`), so those default bindings lower —
 * for every other builtin the default-import fence stands. */
export function builtinDefaultImportModule(spec: string): string | null {
  const canon = canonicalBuiltinModule(spec);
  // node:test's module object IS the test function (`import test from
  // "node:test"; test(...)`), like assert's callable module object.
  return canon === "assert" || canon === "assert/strict" || canon === "events" || canon === "test"
    ? canon
    : null;
}

/** Canonical (bare) name of a supported builtin-module specifier — "fs"
 * for both "fs" and "node:fs" — or null for everything else. The lowering
 * tables and the preflight allowlist share this one normalization. */
export function canonicalBuiltinModule(spec: string): string | null {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (bare === spec && PREFIX_ONLY_BUILTIN_MODULES.has(bare)) return null;
  return (SUPPORTED_BUILTIN_MODULES as readonly string[]).includes(bare) ? bare : null;
}

/** Both specifier spellings of every supported builtin (prefix-only ones
 * keep just the node: form) — the ambient-module allowlist preflight uses. */
export const SUPPORTED_NODE_MODULES: readonly string[] = SUPPORTED_BUILTIN_MODULES.flatMap((m) =>
  PREFIX_ONLY_BUILTIN_MODULES.has(m) ? [`node:${m}`] : [m, `node:${m}`],
);

/* ── out-of-scope builtins ───────────────────────────────────────────────
 * Builtin modules a compiled binary is not going to serve — not "yet",
 * but by construction — each with the reason its SC1010 fence prints.
 * Keyed by CANONICAL (bare) name; the node: prefix strips before lookup,
 * so 'node:sqlite' keys as 'sqlite'. Exact-match only: an npm package
 * whose name collides with none of these keys keeps the generic wording.
 * Everything absent from this table stays the plain "not supported yet"
 * story — genuinely pending surface (console's Console class, stream/web)
 * must not read as permanently refused. */

/** Node's own HTTP/TLS/stream implementation internals, requireable by
 * legacy convention (underscore-prefixed lib/ modules). They expose
 * Node-internal objects — parsers, wrap handles, the Agent's socket
 * pools — that only exist inside Node's own stack. */
const NODE_INTERNAL_REASON =
  "a Node-internal module: it exposes Node's own implementation objects, which the scriptc runtime does not replicate";

const V8_REASON =
  "it observes V8 engine internals — heap statistics and snapshots, GC and CPU profiles, serialize/deserialize — and a compiled binary embeds no V8 engine to observe";

const OUT_OF_SCOPE_BUILTIN_REASONS: Record<string, string | undefined> = {
  v8: V8_REASON,
  inspector: "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  "inspector/promises": "it drives the V8 inspector protocol — debugger, profiler, heap access — and a compiled binary embeds no V8 engine to inspect",
  sqlite: "it wraps the SQLite library bundled into the node executable, and scriptc binaries bundle no SQLite engine",
  domain: "deprecated in Node and slated for removal; its implicit error interception hooks every async callback at engine level, which is not modeled",
  _http_agent: NODE_INTERNAL_REASON,
  _http_client: NODE_INTERNAL_REASON,
  _http_common: NODE_INTERNAL_REASON,
  _http_incoming: NODE_INTERNAL_REASON,
  _http_outgoing: NODE_INTERNAL_REASON,
  _http_server: NODE_INTERNAL_REASON,
  _stream_duplex: NODE_INTERNAL_REASON,
  _stream_passthrough: NODE_INTERNAL_REASON,
  _stream_readable: NODE_INTERNAL_REASON,
  _stream_transform: NODE_INTERNAL_REASON,
  _stream_wrap: NODE_INTERNAL_REASON,
  _stream_writable: NODE_INTERNAL_REASON,
  _tls_common: NODE_INTERNAL_REASON,
  _tls_wrap: NODE_INTERNAL_REASON,
};

/** The SC1010 feature string for an unsupported module specifier: the
 * plain "the 'x' module" for pending surface, with the out-of-scope
 * reason appended for the modules above. Every "the '<spec>' module"
 * fence site words through this one helper. */
export function unsupportedModuleFeatureOf(spec: string): string {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  const reason = Object.hasOwn(OUT_OF_SCOPE_BUILTIN_REASONS, bare) ? OUT_OF_SCOPE_BUILTIN_REASONS[bare] : undefined;
  if (reason !== undefined) return `the '${spec}' module (${reason})`;
  // Target-qualified wording: the module exists in SOME runtime target.
  const target = activeRuntimeTarget();
  if ((spec === "bun" || spec.startsWith("bun:")) && target.family !== "bun") {
    return `the '${spec}' module (a Bun runtime module — compile with --target bun, where its uses trap at runtime instead of failing the build)`;
  }
  if (bare === "ffi" && target.id === "node24") {
    return `the '${spec}' module (node:ffi exists from Node 26 — compile with --target node26)`;
  }
  return `the '${spec}' module`;
}


/** Packages the compiler serves NATIVELY in static builds (no engine): imports bind to the kernel's lowering (lower-effect.ts), never to the package's JavaScript. */
export const KERNEL_MODULES: ReadonlySet<string> = new Set(["effect"]);

export function isKernelModule(spec: string): boolean {
  // Package subpaths share the root kernel. Admission does not promise
  // every export: unsupported uses still receive lowering diagnostics.
  for (const pkg of KERNEL_MODULES) {
    if (spec === pkg || spec.startsWith(`${pkg}/`)) return true;
  }
  return false;
}


/** True when `spec` is a runtime-trapped module UNDER THE ACTIVE TARGET:
 * `bun:*` traps only when the binary reproduces Bun (a Node target has no
 * such module and fences the import instead); `v8` traps everywhere. */
export function isTrapRuntimeModule(spec: string): boolean {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (!TRAP_RUNTIME_MODULES.has(spec) && !TRAP_RUNTIME_MODULES.has(bare)) return false;
  if (spec === "bun" || spec.startsWith("bun:")) return activeRuntimeTarget().family === "bun";
  return true;
}


/** The runtime-TRAPPED modules (the Bun-target story): imports TYPECHECK
 * against the project's own bun-types surface, but a compiled binary has
 * no runtime module to serve — so the import emits no edge and every USE
 * (call, construct, value read) of a trap binding throws a catchable
 * error at runtime naming the module. The honest middle between a build
 * failure (the 5.9.3 posture) and a silent wrong answer: the program
 * builds and runs everything that never touches these paths, and the
 * trapped paths fail loud at their own use site. */
export const TRAP_RUNTIME_MODULES: ReadonlySet<string> = new Set([
  "bun",
  "bun:sqlite",
  "bun:ffi",
  "v8",
  "node:v8",
]);


/** The "bun" module's re-exports of node:url members (bun-types declares
 * `module "bun"` re-exporting them — the redcode authoring imports
 * `pathToFileURL` from "bun"). Members in this table lower exactly like
 * their node:url originals; the "bun" module's other surface (the Bun
 * global, its APIs — `plugin`, `serve`, …) traps at its use sites under
 * --target bun, like bun:sqlite/bun:ffi, and keeps its fence elsewhere. */
export const BUN_MODULE_MEMBER_ALIASES: Readonly<Record<string, string | undefined>> = {
  pathToFileURL: "url",
  fileURLToPath: "url",
};
