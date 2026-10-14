import type { ScrDiagnostic } from "@scriptc/compiler";

export interface DiagnosticsOutput {
  compilerVersion: string;
  command: string;
  entry?: string;
  backend?: string;
  target?: string;
  success: boolean;
  phase: "arguments" | "preflight" | "analysis" | "build" | "toolchain";
  diagnostics: readonly ScrDiagnostic[];
  deferred?: readonly ScrDiagnostic[];
  stats?: object;
  artifact?: string;
  error?: string;
}

/** Version the machine contract independently of terminal rendering. A source
 * diagnostic is not, by itself, a claim about whether the consumer is at fault. */
export function diagnosticsOutput(options: DiagnosticsOutput): object {
  const located = [
    ...options.diagnostics.map(diagnostic => ({ ...diagnostic, scope: options.phase === "preflight" ? "preflight" : "reached" })),
    ...(options.deferred ?? []).map(diagnostic => ({ ...diagnostic, scope: "deferred" })),
  ].map(diagnostic => {
    const clean = { ...diagnostic };
    delete clean.milestone;
    return clean;
  });
  const groups = new Map<string, { code: string; message: string; scope: string; count: number }>();
  for (const diagnostic of located) {
    const key = JSON.stringify([diagnostic.code, diagnostic.message, diagnostic.scope]);
    const previous = groups.get(key);
    if (previous) previous.count++;
    else groups.set(key, { code: diagnostic.code, message: diagnostic.message, scope: diagnostic.scope, count: 1 });
  }
  const context = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "diagnostics" && key !== "deferred"));
  return { schema: "scriptc-diagnostics", schemaVersion: 1, ...context, parity: "unverified", groups: [...groups.values()], diagnostics: located };
}
