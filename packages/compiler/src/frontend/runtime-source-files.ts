import * as ts from "./ts7/adapter.js";
import { forkTargetPaths } from "./fork-target.js";

/** The checker keeps type dependencies; structural runtime admission only
 * visits source reachable through executable module edges. Dynamic imports
 * and fork targets need admission too, but are not startup init edges. */
export function runtimeSourceFiles(
  program: ts.Program,
  entry: ts.SourceFile,
  files: readonly ts.SourceFile[],
  staticDependencies: (sf: ts.SourceFile) => readonly ts.SourceFile[],
  callDependency: (sf: ts.SourceFile, call: ts.CallExpression) => ts.SourceFile | null,
): ts.SourceFile[] {
  const available = new Set(files);
  const reached = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [];
  const request = (sf: ts.SourceFile | null): void => {
    if (sf === null || !available.has(sf) || reached.has(sf)) return;
    reached.add(sf);
    queue.push(sf);
  };
  request(entry);
  for (let index = 0; index < queue.length; index++) {
    const sf = queue[index]!;
    for (const dep of staticDependencies(sf)) request(dep);
    ts.walkPreorder(sf, node => {
      if (ts.isCallExpression(node)) request(callDependency(sf, node));
      return undefined;
    });
    for (const path of forkTargetPaths(program, [sf])) request(program.getSourceFile(path) ?? null);
  }
  // Preserve the checker's file order for deterministic diagnostics.
  return files.filter(sf => reached.has(sf));
}
