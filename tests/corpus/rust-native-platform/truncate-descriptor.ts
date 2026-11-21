import { appendFileSync, closeSync, ftruncateSync, openSync, readFileSync, unlinkSync } from "node:fs";

const path = "truncate-fixture";
appendFileSync(path, "abcde");
const fd = openSync(path, "r+");
ftruncateSync(fd, 3);
console.log("short", readFileSync(path, "utf8"));
try {
  ftruncateSync(fd, 1.5);
} catch (error) {
  const caught = error as NodeJS.ErrnoException;
  console.log("error", caught.name, caught.code === "ERR_OUT_OF_RANGE", caught.message);
}
ftruncateSync(fd, -1);
console.log("empty", readFileSync(path, "utf8").length);
closeSync(fd);
unlinkSync(path);
