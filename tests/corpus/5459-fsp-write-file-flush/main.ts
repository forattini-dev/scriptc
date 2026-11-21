import { readFile, rm, writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const path = `scriptc-write-file-flush-${process.pid}.txt`;
  await writeFile(path, "first", { flush: false });
  await writeFile(path, "durable", { flush: true });
  console.log(await readFile(path, "utf8"));
  await rm(path);
}

void main();
