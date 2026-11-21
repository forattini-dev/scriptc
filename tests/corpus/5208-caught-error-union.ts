let failure: Error | null = null;

try {
  throw new Error("native");
} catch (err) {
  failure = err as Error;
}

console.log(failure?.message ?? "missing");
