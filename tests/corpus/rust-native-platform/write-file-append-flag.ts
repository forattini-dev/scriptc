import { readFile, writeFile, rm } from "node:fs/promises";

async function main(): Promise<void> {
  const path = `scriptc-write-file-append-${process.pid}.txt`;
  await writeFile(path, "one", { flag: "a" });
  await writeFile(path, "two", { flag: "a" });
  console.log(await readFile(path, "utf8"));
  await rm(path);
}

void main();
