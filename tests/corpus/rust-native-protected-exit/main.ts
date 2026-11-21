// @rust-only
// @no-engine

function recordCrash(kind: string): string {
  return kind;
}

async function endWithCrash(kind: string): Promise<never> {
  const capture = recordCrash(kind);
  try {
    const { handOffCrash } = await import("./handoff.ts");
    await handOffCrash(capture);
  } catch {
    // The original crash remains authoritative.
  }
  process.exit(70);
}

if (process.argv[2] === "crash") {
  void endWithCrash("boom");
}
