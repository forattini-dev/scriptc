import { compile, type CompileOptions, type CompileResult } from "./index.js";

/** Build-time API compatibility fence: a caller's existing CompileOptions
 * variable must retain the executable result aliases without narrowing. */
async function assertCompileOptionsCompatibility(
  entryPath: string,
  opts: CompileOptions,
): Promise<void> {
  const result = await compile(entryPath, opts);
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileOptionsCompatibility;

/** The historical exported CompileResult itself remains executable-shaped. */
function assertCompileResultCompatibility(result: CompileResult): void {
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileResultCompatibility;
