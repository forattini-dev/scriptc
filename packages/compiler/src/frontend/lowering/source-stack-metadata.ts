import { pathToFileURL } from "node:url";
import * as ts from "../ts7/adapter.js";
import { isNodeEsmFile } from "../program.js";
import { moduleHasLibCall, type IrModule } from "../../ir/ir.js";

/** Keep source coordinates in serialized IR: code generation must not need
 * the original files on disk, nor expose generated Rust locations as JS. */
export function attachSourceStackMetadata(module: IrModule, sources: readonly ts.SourceFile[]): void {
  if (!moduleHasLibCall(module, "error.captureStackTrace") && !moduleHasLibCall(module, "error.captureStackTraceExclude") && !moduleHasLibCall(module, "error.stack")) return;
  module.sourceStackFiles = sources.map(source => {
    const callOffsets: { start: number; end: number; position: number }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) callOffsets.push({ start: node.getStart(source), end: node.end, position: node.expression.name.getStart(source) });
      ts.forEachChild(node, visit);
    };
    visit(source);
    const lineStarts = [0];
    for (let i = 0; i < source.text.length; i++) {
      const character = source.text.charCodeAt(i);
      if (character === 13 && source.text.charCodeAt(i + 1) === 10) i++;
      if (character === 10 || character === 13 || character === 0x2028 || character === 0x2029) lineStarts.push(i + 1);
    }
    return { file: source.fileName, displayFile: isNodeEsmFile(source) ? pathToFileURL(source.fileName).href : source.fileName, length: source.text.length, lineStarts, callOffsets };
  });
}
