// Awaiting a package promise nothing can settle: the fiber parks forever,
// no referenced work remains, and the process exits 0 — Node's
// await-forever. The blocking bridge had no pending state to hold and
// raised ERR_MODULE_PROMISE_PENDING here instead.
import { never, settled } from "promisezoo";

async function run(): Promise<void> {
  const first: number = await settled(3);
  console.log("settled: " + String(first));
  await never();
  console.log("unreached");
}
run();
console.log("main done");
