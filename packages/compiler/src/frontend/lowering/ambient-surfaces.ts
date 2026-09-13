import type { IrLibFn } from "../../ir/ir.js";

/** Ambient surfaces lowered through DEDICATED code paths (no lowering-table
 * row): the Date compositions, perf_hooks' performance.now, and the process
 * global's ambient reads and authority calls. These are the determinism
 * attestation's ground (ir/ir.ts's LIB_NONDETERMINISTIC_PREFIXES), so
 * each row projects one surface-manifest entry — a permanent, fenceable id
 * — and carries the libCall spellings that witness the surface's reach in
 * a compiled graph (the fence detector and the attestation must agree; the
 * parity test in tests/harness/surface-manifest.test.ts holds them to it). */
export interface AmbientSurfaceRow {
  /** The manifest entry id (stable diff key — permanent API). */
  id: string;
  kind: "stdlib" | "node-builtin";
  /** Human-readable surface name (the manifest's `name`). */
  name: string;
  /** The IrLibFn spellings whose reach witnesses the surface. */
  fns: readonly IrLibFn[];
  note?: string;
}

export const AMBIENT_SURFACE_FNS: readonly AmbientSurfaceRow[] = [
  {
    id: "stdlib.crypto.randomUUID",
    kind: "stdlib",
    name: "crypto.randomUUID",
    fns: ["crypto.randomUUID"],
    note: "zero-argument WebCrypto calls through crypto and globalThis.crypto use OS entropy for UUID v4; corpus:3174-global-crypto-uuid and corpus:3175-bun-global-crypto-uuid verify format and user-binding shadowing",
  },
  // ── the Date slice (lowerDateCall/lowerNew): statics, construction,
  // stored read-only values, calendar getters, and ISO formatting.
  {
    id: "stdlib.date.now",
    kind: "stdlib",
    name: "Date.now",
    fns: ["date.now"],
    note: "the live clock",
  },
  {
    id: "stdlib.date.constructor",
    kind: "stdlib",
    name: "Date constructor",
    fns: ["date.newNow", "date.newMs", "date.newString", "date.newComponents"],
    note: "zero arguments, one milliseconds/date-string argument, or local calendar components; read-only TimeClip values",
  },
  {
    id: "stdlib.date.UTC",
    kind: "stdlib",
    name: "Date.UTC",
    fns: ["date.utc"],
    note: "the lowered call form takes 1 to 7 number arguments",
  },
  {
    id: "stdlib.date.getTime",
    kind: "stdlib",
    name: "Date.prototype.getTime",
    fns: ["date.getTime"],
    note: "the millisecond value of a stored Date",
  },
  {
    id: "stdlib.date.parse",
    kind: "stdlib",
    name: "Date.parse",
    fns: ["date.parseGetTime"],
    note: "one date-string argument; invalid input returns NaN",
  },
  {
    id: "stdlib.date.valueOf",
    kind: "stdlib",
    name: "Date.prototype.valueOf",
    fns: ["date.valueOf"],
    note: "the same millisecond read as getTime()",
  },
  {
    id: "stdlib.date.toISOString",
    kind: "stdlib",
    name: "Date.prototype.toISOString",
    fns: ["date.toISOString", "date.toISOStringValue"],
    note: "UTC ISO formatting over constructed and stored Date values",
  },
  { id: "stdlib.date.getFullYear", kind: "stdlib", name: "Date.prototype.getFullYear", fns: ["date.getFullYear"] },
  { id: "stdlib.date.getUTCFullYear", kind: "stdlib", name: "Date.prototype.getUTCFullYear", fns: ["date.getUTCFullYear"] },
  { id: "stdlib.date.getMonth", kind: "stdlib", name: "Date.prototype.getMonth", fns: ["date.getMonth"] },
  { id: "stdlib.date.getUTCMonth", kind: "stdlib", name: "Date.prototype.getUTCMonth", fns: ["date.getUTCMonth"] },
  { id: "stdlib.date.getDate", kind: "stdlib", name: "Date.prototype.getDate", fns: ["date.getDate"] },
  { id: "stdlib.date.getUTCDate", kind: "stdlib", name: "Date.prototype.getUTCDate", fns: ["date.getUTCDate"] },
  { id: "stdlib.date.getDay", kind: "stdlib", name: "Date.prototype.getDay", fns: ["date.getDay"] },
  { id: "stdlib.date.getUTCDay", kind: "stdlib", name: "Date.prototype.getUTCDay", fns: ["date.getUTCDay"] },
  { id: "stdlib.date.getHours", kind: "stdlib", name: "Date.prototype.getHours", fns: ["date.getHours"] },
  { id: "stdlib.date.getUTCHours", kind: "stdlib", name: "Date.prototype.getUTCHours", fns: ["date.getUTCHours"] },
  { id: "stdlib.date.getMinutes", kind: "stdlib", name: "Date.prototype.getMinutes", fns: ["date.getMinutes"] },
  { id: "stdlib.date.getUTCMinutes", kind: "stdlib", name: "Date.prototype.getUTCMinutes", fns: ["date.getUTCMinutes"] },
  { id: "stdlib.date.getSeconds", kind: "stdlib", name: "Date.prototype.getSeconds", fns: ["date.getSeconds"] },
  { id: "stdlib.date.getUTCSeconds", kind: "stdlib", name: "Date.prototype.getUTCSeconds", fns: ["date.getUTCSeconds"] },
  { id: "stdlib.date.getMilliseconds", kind: "stdlib", name: "Date.prototype.getMilliseconds", fns: ["date.getMilliseconds"] },
  { id: "stdlib.date.getUTCMilliseconds", kind: "stdlib", name: "Date.prototype.getUTCMilliseconds", fns: ["date.getUTCMilliseconds"] },
  { id: "stdlib.date.getTimezoneOffset", kind: "stdlib", name: "Date.prototype.getTimezoneOffset", fns: ["date.getTimezoneOffset"] },
  // ── perf_hooks (lowerPerfHooksCall): the monotonic clock.
  {
    id: "node-builtin.perf_hooks.performance.now",
    kind: "node-builtin",
    name: "perf_hooks.performance.now",
    fns: ["perf.now"],
    note: "the global performance object and the performance.now.bind(performance) function value reach the same clock",
  },
  // ── the process global's ambient reads and authority calls
  // (lowerProcessProperty/lowerProcessMethodCall — process is a
  // provenance-checked global here, not an importable module).
  {
    id: "node-builtin.process.env",
    kind: "node-builtin",
    name: "process.env",
    fns: ["process.envGet", "process.envSet", "process.envUnset", "process.envPairs"],
    note: "reads, writes, deletes, and enumeration of the process environment (the process global)",
  },
  { id: "node-builtin.process.argv", kind: "node-builtin", name: "process.argv", fns: ["process.argv"] },
  { id: "node-builtin.process.cwd", kind: "node-builtin", name: "process.cwd", fns: ["process.cwd"] },
  { id: "node-builtin.process.chdir", kind: "node-builtin", name: "process.chdir", fns: ["process.chdir"] },
  { id: "node-builtin.process.pid", kind: "node-builtin", name: "process.pid", fns: ["process.pid"] },
  { id: "node-builtin.process.getuid", kind: "node-builtin", name: "process.getuid", fns: ["process.getuid"] },
  { id: "node-builtin.process.getgid", kind: "node-builtin", name: "process.getgid", fns: ["process.getgid"] },
  { id: "node-builtin.process.execPath", kind: "node-builtin", name: "process.execPath", fns: ["process.execPath"] },
  { id: "node-builtin.process.uptime", kind: "node-builtin", name: "process.uptime", fns: ["process.uptime"] },
  {
    id: "node-builtin.process.availableMemory",
    kind: "node-builtin",
    name: "process.availableMemory",
    fns: ["process.availableMemory"],
  },
  {
    id: "node-builtin.process.constrainedMemory",
    kind: "node-builtin",
    name: "process.constrainedMemory",
    fns: ["process.constrainedMemory"],
  },
  {
    id: "node-builtin.process.resourceUsage",
    kind: "node-builtin",
    name: "process.resourceUsage",
    fns: ["process.rusage"],
    note: "getrusage's 16 fields — every field read samples live machine state",
  },
  {
    id: "node-builtin.process.cpuUsage",
    kind: "node-builtin",
    name: "process.cpuUsage",
    fns: ["process.cpuUser", "process.cpuSystem", "process.cpuUserDiff", "process.cpuSystemDiff", "process.cpuPrevValidate"],
    note: "the plain-sample and previous-value diff forms are one surface",
  },
  {
    id: "node-builtin.process.threadCpuUsage",
    kind: "node-builtin",
    name: "process.threadCpuUsage",
    fns: ["process.threadCpuUser", "process.threadCpuSystem", "process.threadCpuUserDiff", "process.threadCpuSystemDiff"],
    note: "the plain-sample and previous-value diff forms are one surface",
  },
  {
    id: "node-builtin.process.isTTY",
    kind: "node-builtin",
    name: "process.isTTY",
    fns: ["process.isTTY"],
    note: "the isTTY read on process.stdin/stdout/stderr — one surface across the three streams",
  },
  {
    id: "node-builtin.process.columns",
    kind: "node-builtin",
    name: "process.columns",
    fns: ["process.columns"],
    note: "the columns read on the process stdio streams (terminal geometry)",
  },
  {
    id: "node-builtin.process.rows",
    kind: "node-builtin",
    name: "process.rows",
    fns: ["process.rows"],
    note: "the rows read on the process stdio streams (terminal geometry)",
  },
  {
    id: "node-builtin.process.kill",
    kind: "node-builtin",
    name: "process.kill",
    fns: ["process.kill", "process.killNum"],
    note: "the signal-name and signal-number forms are one surface",
  },
  { id: "node-builtin.process.umask", kind: "node-builtin", name: "process.umask", fns: ["process.umask"] },
  {
    id: "node-builtin.process.exit",
    kind: "node-builtin",
    name: "process.exit",
    fns: ["process.exit", "process.exitCodeSet", "process.exiting"],
    note: "process.exit, process.exitCode, and the process._exiting flag read are one surface",
  },
  // ── the tls CA store (lowerTlsCaCall / lowerTlsRootCertificates): the
  // host's trust anchors, read and replaced. Dedicated paths, and
  // rootCertificates is a VALUE read with no call form at all, so none of
  // the three can hang off a lowering-table row. Split three ways rather
  // than folded into one "CA store" surface: a library author who denies
  // REPLACING the trust anchors is making a different decision from one
  // who denies reading them, and each Node spelling is the name they will
  // reach for when writing the fence.
  {
    id: "node-builtin.tls.getCACertificates",
    kind: "node-builtin",
    name: "tls.getCACertificates",
    fns: ["tlsca.get"],
    note: "the per-type cached PEM bundle: 'default' and 'extra' additionally read NODE_EXTRA_CA_CERTS, 'system' the platform store",
  },
  {
    id: "node-builtin.tls.rootCertificates",
    kind: "node-builtin",
    name: "tls.rootCertificates",
    fns: ["tlsca.root"],
    note: "the value read; answers the same bundled array as getCACertificates('bundled'), but fenced under its own id — the spelling an author writes",
  },
  {
    id: "node-builtin.tls.setDefaultCACertificates",
    kind: "node-builtin",
    name: "tls.setDefaultCACertificates",
    fns: ["tlsca.set"],
    note: "replaces the default set and the client trust anchors for the rest of the process",
  },
];
