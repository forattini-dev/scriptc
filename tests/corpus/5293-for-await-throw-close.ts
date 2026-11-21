// @rust-only
// @target bun
// @no-engine
/// <reference path="rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
async function main(): Promise<void> {
  const events: string[] = [];
  const child = Bun.spawn([process.env.SCRIPTC_EXEC_FILE_HELPER ?? "", "ok"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stream = child.stdout;

  try {
    for await (const chunk of stream) {
      events.push(`chunk:${chunk.byteLength}`);
      throw new Error("stop");
    }
  } catch (error) {
    events.push(`caught:${(error as Error).message}`);
  }
  console.log(events.join(","));
}

void main();
