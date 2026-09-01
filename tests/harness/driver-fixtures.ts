/** Corpus programs that CANNOT run standalone: they take a port on argv,
 * or wait for payloads a harness must deliver from outside. Each one has a
 * dedicated driver test that spins the other side and passes the argv —
 * the bare differential lanes (C, LLVM, Rust) must skip them, or both the
 * Node oracle and the native binary crash on the missing argument.
 *
 * Driver homes:
 * - 2807 → packages/compiler/test/emit-rust-network.test.ts ("open stdin")
 * - 2808 → packages/compiler/test/emit-rust-dgram.test.ts (dgram with open stdin)
 * - 2809, 2811 → packages/compiler/test/emit-rust-io-poll.test.ts
 * - 2810 → packages/compiler/test/emit-rust-network.test.ts (dgram driver)
 *
 * Adding here is a last resort: a corpus program that can express its own
 * two sides in-process (the 2696-http-server-net-roundtrip.ts pattern)
 * needs no driver and stays in every lane.
 */
export const DRIVER_FIXTURES: ReadonlySet<string> = new Set([
  "2807-event-loop-stdin-network-fairness.ts",
  "2808-event-loop-stdin-dgram-fairness.ts",
  "2809-net-poll-context-switches.ts",
  "2810-dgram-poll-context-switches.ts",
  "2811-net-dgram-unified-poll.ts",
]);
