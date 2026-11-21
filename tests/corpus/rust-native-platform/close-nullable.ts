import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";

function closeMaybe(fd: number | undefined | null): void {
  try {
    console.log("body");
  } finally {
    // Exercise the runtime argument check even when the checker rejects this call.
    // @ts-ignore
    closeSync(fd);
  }
}

const path = "close-nullable-fixture";
appendFileSync(path, "x");
closeMaybe(openSync(path, "r"));
for (const value of [undefined, null]) {
  try {
    closeMaybe(value);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("error", caught.name, caught.code === "ERR_INVALID_ARG_TYPE", caught.message);
  }
}
unlinkSync(path);
