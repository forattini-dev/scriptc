// @rust-only
// @no-engine
import { once } from "node:events";

async function main(): Promise<void> {
  const accepted = process.stdout.write("");
  if (!accepted) await once(process.stdout, "drain");
  console.log("drain", accepted);
}

main();
