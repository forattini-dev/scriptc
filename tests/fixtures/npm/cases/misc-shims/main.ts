// @dynamic
// @no-deprecation
// The island's misc shim tier, differentially against Node — every line
// byte-exact (misczoo runs the surface inside the engine).
import { report } from "misczoo";

async function run(): Promise<void> {
  const out: string = await report();
  console.log(out);
}
run();
