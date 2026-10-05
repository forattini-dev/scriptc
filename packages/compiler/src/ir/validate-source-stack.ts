import type { IrExpr, IrModule, SrcLoc } from "./ir.js";
import { moduleHasLibCall } from "./ir.js";

const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** Serialized coordinates are untrusted IR, not a reason to reopen source files. */
export function validateSourceStack(module: IrModule, err: (message: string, loc: SrcLoc) => void): void {
  const files = module.sourceStackFiles;
  const loc = { file: module.sourceFile, start: 0, end: 0 };
  if (files === undefined || files.length === 0) {
    if ((["error.captureStackTrace", "error.captureStackTraceExclude", "error.stack"] as const).some(fn => moduleHasLibCall(module, fn))) err("source stack requires original-source coordinates", loc);
    if (files === undefined) return;
  }
  if (!Array.isArray(files)) { err("source stack files must be an array", loc); return; }
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.file !== "string" || !file.file || typeof file.displayFile !== "string" || !file.displayFile || !coordinate(file.length)) {
      err("source stack file requires a source identity, display path and bounded length", loc);
      continue;
    }
    if (seen.has(file.file)) err("source stack has duplicate file identities", loc);
    seen.add(file.file);
    if (!Array.isArray(file.lineStarts) || file.lineStarts[0] !== 0 || file.lineStarts.some((start, index, starts) => !coordinate(start) || start > file.length || (index > 0 && start <= (starts[index - 1] ?? -1)))) {
      err("source stack line starts must begin at zero and increase within the source length", loc);
    }
    if (file.callOffsets === undefined) continue;
    if (!Array.isArray(file.callOffsets)) { err("source stack call offsets must be an array", loc); continue; }
    const calls = new Set<string>();
    for (const call of file.callOffsets) {
      if (!call || !coordinate(call.start) || !coordinate(call.end) || !coordinate(call.position) || call.start > call.position || call.position >= call.end || call.end > file.length) {
        err("source stack call positions must be within their source ranges", loc);
        continue;
      }
      const key = `${call.start}:${call.end}`;
      if (calls.has(key)) err("source stack has duplicate call ranges", loc);
      calls.add(key);
    }
  }
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const node = value as Partial<Extract<IrExpr, { kind: "libCall" }>>;
    if (node.kind === "libCall" && (node.fn === "error.captureStackTrace" || node.fn === "error.captureStackTraceExclude" || node.fn === "error.stack")) {
      const site = node.loc;
      const file = files.find(file => file?.file === site?.file);
      if (!file || !site || !coordinate(site.start) || !coordinate(site.end) || site.end < site.start || site.end > file.length) {
        err("source stack operation requires matching source coordinates", site ?? loc);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(module.functions);
  visit(module.globals);
}
