// @dynamic
// @no-deprecation
// The island's node:util (and node:util/types) shims, differentially
// against Node: inspect/format/promisify/callbackify/inherits/
// isDeepStrictEqual/parseArgs/stripVTControlCharacters/styleText/types —
// every line byte-exact (utilzoo runs the surface inside the engine).
import { report } from "utilzoo";

async function run(): Promise<void> {
  const out: string = await report();
  console.log(out);
}
run();
