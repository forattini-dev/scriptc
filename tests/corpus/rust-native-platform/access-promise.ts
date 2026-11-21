import { constants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";

const path = `${process.cwd()}/scriptc-access-promise-fixture.tmp`;
async function main(): Promise<void> {
  await writeFile(path, "ok");
  try {
    await access(path, constants.F_OK);
    console.log("exists");
  } finally {
    await rm(path);
  }

  try {
    await access(path);
  } catch (error) {
    console.log((error as NodeJS.ErrnoException).code);
  }
}

main();
