import { createWriteStream, readFileSync, unlinkSync } from "node:fs";

async function main(): Promise<void> {
  const path = `scriptc-write-stream-${process.pid}.bin`;
  const stream = createWriteStream(path, { flags: "w" });
  stream.on("error", (error) => { throw error; });
  const chunk = Buffer.from("A".repeat(70000));
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve) => stream.once("drain", resolve));
  }
  await new Promise<void>((resolve) => stream.end(resolve));
  const result = readFileSync(path);
  unlinkSync(path);
  console.log(result.length, result[0], result[result.length - 1]);
}

void main();
