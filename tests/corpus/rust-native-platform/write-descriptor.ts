import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

const path = "write-descriptor-fixture";
const fd = openSync(path, "w");
const bytes = new Uint8Array([65, 66, 67, 68]);
console.log("written", writeSync(fd, bytes.subarray(1, 3)));
closeSync(fd);
console.log("content", readFileSync(path, "utf8"));
unlinkSync(path);
