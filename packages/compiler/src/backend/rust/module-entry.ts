import type { IrFunction, IrGlobal, IrLibSection } from "../../ir/nodes.js";
import { emitRustLibraryEntries } from "./library-entry.js";
import { emitRustProgramEntry } from "./program-entry.js";

export interface RustModuleEntryOptions {
  readonly lib: IrLibSection | undefined;
  readonly entry: IrFunction | undefined;
  readonly entryName: string;
  readonly entryCommonJs: boolean;
  readonly hasErrorClasses: boolean;
  readonly globals: readonly IrGlobal[];
  readonly internedClosureNames: readonly string[];
  readonly usesDyn: boolean;
  readonly usesDynamicInvoke: boolean;
  readonly usesProcessExitListeners: boolean;
  readonly usesProcessRejectionEvents: boolean;
  readonly usesProcessWarningEvents: boolean;
  readonly usesEmbeddedModules: boolean;
  readonly isHeapGlobal: (global: IrGlobal) => boolean;
  readonly unsupported: (kind: string) => never;
}

/** Select the process or host-library boundary without burdening the core
 * expression emitter with either delivery mode's lifecycle details. */
export function emitRustModuleEntry(options: RustModuleEntryOptions): string[] {
  const entry = options.entry;
  if (entry === undefined) options.unsupported(`missing entry '${options.entryName}'`);
  if (entry.params.length !== 0 || entry.returnType.kind !== "void") {
    options.unsupported("entry signature");
  }
  if (options.lib !== undefined) {
    return emitRustLibraryEntries({
      lib: options.lib,
      entryName: entry.name,
      hasErrorClasses: options.hasErrorClasses,
      globals: options.globals,
      internedClosureNames: options.internedClosureNames,
      unsupported: options.unsupported,
    });
  }
  return emitRustProgramEntry({
    entryName: entry.name,
    entryAsync: entry.async === true,
    entryCommonJs: options.entryCommonJs,
    hasErrorClasses: options.hasErrorClasses,
    heapGlobalIds: options.globals.filter(options.isHeapGlobal).map((global) => global.id),
    internedClosureNames: options.internedClosureNames,
    usesDyn: options.usesDyn,
    usesDynamicInvoke: options.usesDynamicInvoke,
    usesProcessExitListeners: options.usesProcessExitListeners,
    usesProcessRejectionEvents: options.usesProcessRejectionEvents,
    usesProcessWarningEvents: options.usesProcessWarningEvents,
    usesEmbeddedModules: options.usesEmbeddedModules,
  });
}
