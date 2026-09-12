import { moduleEmbedsBuiltin, moduleUsesFetch, type IrModule, type SrcLoc } from "../ir/ir.js";

/** APIs that require host capabilities absent from portable WASI Preview 1.
 * These are target diagnostics, not backend-tier gaps: the same language IR
 * (including async, generators, and the dynamic island) is otherwise valid.
 * Keep the fine-grained walk first so diagnostics point at the API use; the
 * embedded-module checks are the entry-anchored safety net for island code. */
export function moduleWasiUnavailableSurface(mod: IrModule): { surface: string; loc: SrcLoc } | null {
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const prefixes: readonly (readonly [string, string])[] = [
    ["cp.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["child.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["net.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http.", "network sockets (WASI Preview 1 has no socket API)"],
    ["https.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["h2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgram.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dns.", "network sockets (WASI Preview 1 has no socket API)"],
    ["tls.", "network sockets (WASI Preview 1 has no socket API)"],
    ["fetch.", "network-backed fetch (WASI Preview 1 has no socket API)"],
    ["fs.watch", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["fs.realpath", "filesystem canonical paths (the WASI runtime has no realpath implementation)"],
    ["fs.chmod", "filesystem permission changes (WASI Preview 1 has no chmod API)"],
    ["fsp.chmod", "filesystem permission changes (WASI Preview 1 has no chmod API)"],
    ["watcher.", "filesystem watching (WASI Preview 1 has no notification API)"],
  ];
  const kinds: ReadonlyMap<string, string> = new Map([
    ["child", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childStream", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["netServer", "network sockets (WASI Preview 1 has no socket API)"],
    ["netSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Session", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Stream", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgramSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["fsWatcher", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["httpReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpRes", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpClientReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["secureCtx", "network sockets (WASI Preview 1 has no socket API)"],
  ]);
  let found: { surface: string; loc: SrcLoc } | null = null;
  const visit = (value: unknown, inheritedLoc: SrcLoc): void => {
    if (found !== null || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedLoc);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; loc?: SrcLoc };
    const loc = node.loc ?? inheritedLoc;
    if (typeof node.kind === "string") {
      const kindSurface = kinds.get(node.kind);
      if (kindSurface !== undefined) {
        found = { surface: kindSurface, loc };
        return;
      }
      if (node.kind === "libCall" && typeof node.fn === "string") {
        if (node.fn === "process.kill" || node.fn === "process.killNum" ||
            node.fn === "process.onSignal" || node.fn === "process.offSignal") {
          found = { surface: "OS signals (WASI Preview 1 has no signal API)", loc };
          return;
        }
        if (node.fn === "os.networkInterfaces") {
          found = { surface: "network-interface enumeration (WASI Preview 1 has no interface API)", loc };
          return;
        }
        for (const [prefix, surface] of prefixes) {
          if (node.fn.startsWith(prefix)) {
            found = { surface, loc };
            return;
          }
        }
      }
    }
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key], loc);
    }
  };
  visit(mod, entryLoc);
  if (found !== null) return found;

  if (moduleUsesFetch(mod)) {
    return { surface: "network-backed fetch (WASI Preview 1 has no socket API)", loc: entryLoc };
  }
  for (const builtin of ["node:http", "node:https", "node:net", "node:tls"] as const) {
    if (moduleEmbedsBuiltin(mod, builtin)) {
      return { surface: `${builtin} networking (WASI Preview 1 has no socket API)`, loc: entryLoc };
    }
  }
  return null;
}
