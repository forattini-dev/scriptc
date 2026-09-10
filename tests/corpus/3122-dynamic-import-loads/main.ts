// @dynamic
// Exercise the admitted imports before the deliberately absent computed name.
// Loading http2 does not assert that the embedded engine implements its APIs.
import { tag } from "./helper.ts";

async function run(): Promise<void> {
  const own = await import("./helper.ts");
  console.log(own.tag());
  const protocol = await import("http2");
  console.log(typeof protocol.connect);
  const name = "scriptc-missing-package-" + tag();
  try {
    await import(name);
    console.log("unexpected module");
  } catch (error) {
    console.log("missing module", error instanceof Error);
  }
}
run();
