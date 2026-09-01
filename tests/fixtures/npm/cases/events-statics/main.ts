// @dynamic
// The node:events module statics the island announces as named exports,
// differentially against Node: `on` (the async iterator over an emitter's
// events, which the export table promised but the shim never defined) and
// `once`, across the break / close / error exits — eventszoo runs the
// surface inside the engine.
import { report } from "eventszoo";

async function run(): Promise<void> {
  const out: string = await report();
  console.log(out);
}
run();
