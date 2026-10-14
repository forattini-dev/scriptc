import { appendFileSync } from "node:fs";

/** Optional evidence only: assertions and admission are owned by the
 * differential harness. Each shard writes to its own append-only log. */
export function recordRustCorpus(event: Record<string, unknown>): void {
  const output = process.env["SCRIPTC_RUST_CORPUS_LEDGER"];
  if (!output) return;
  appendFileSync(output, JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...event }) + "\n");
}
