// Agent-written CLI code commonly centralizes Node error handling behind an
// `unknown` parameter, then probes ErrnoException.code with optional chaining.
// The dynamic boundary must preserve a real Node Error and undefined exactly.
import { readFileSync } from "node:fs";

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "none";
}

try {
  readFileSync("/scriptc-agentic-definitely-missing-2741", "utf8");
} catch (error) {
  console.log(errorCode(error));
}

console.log(errorCode(undefined));
console.log(errorCode(new Error("plain")));
