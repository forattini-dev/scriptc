import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) {
      return nextLoad(url, context);
    }
    const path = fileURLToPath(url);
    if (!/\.[cm]?ts$/u.test(path)) return nextLoad(url, context);
    const source = readFileSync(path, "utf8");
    const commonjs = path.endsWith(".cts");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      },
      fileName: path,
    }).outputText;
    const format = commonjs || context.format === "commonjs-typescript" ? "commonjs" : "module";
    return { format, source: output, shortCircuit: true };
  },
});
