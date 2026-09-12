// @dynamic
// Exercise the admitted imports before the deliberately absent computed name.
// Loading http2 does not assert that the embedded engine implements its APIs.
import { tag } from "./helper.ts";

// Inspect the dynamic engine namespace without converting it to a native record.
function logExport(name: string, namespace: any, exported: string): void {
  console.log(name, typeof namespace[exported]);
}

async function run(): Promise<void> {
  const own = await import("./helper.ts");
  console.log(own.tag());
  const protocol = await import("http2");
  console.log(typeof protocol.connect);
  logExport("dgram", await import("dgram"), "createSocket");
  logExport("cluster", await import("cluster"), "fork");
  logExport("events", await import("events"), "addAbortListener");
  logExport("module", await import("module"), "findPackageJSON");
  const name = "scriptc-missing-package-" + tag();
  try {
    await import(name);
    console.log("unexpected module");
  } catch (error) {
    console.log("missing module", error instanceof Error);
  }
}
run();
