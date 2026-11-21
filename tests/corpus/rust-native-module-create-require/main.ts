import { createRequire } from "node:module";

interface LoaderOptions {
  readonly requireFn?: (path: string) => unknown;
}

let evaluations = 0;
function base(): string {
  evaluations += 1;
  return import.meta.url;
}

const requireFromHere = createRequire(base());
console.log("base evaluations", evaluations);

function attempt(specifier: string): void {
  try {
    requireFromHere(specifier);
    console.log("loaded", specifier);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    console.log(error instanceof Error, error.code, error.message.split("\n")[0]);
  }
}

attempt("./definitely-missing-addon.node");
attempt("./also-missing.js");

function load(options: LoaderOptions): string {
  const requireFn = options.requireFn ?? createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = requireFn("./missing-binding.node");
  } catch (err) {
    return err instanceof Error
      ? `unavailable: ${(err as NodeJS.ErrnoException).code}`
      : "unavailable";
  }
  return `loaded ${typeof loaded}`;
}

console.log(load({}));
console.log(load({ requireFn: (path) => ({ path }) }));
console.log("base evaluations", evaluations);
