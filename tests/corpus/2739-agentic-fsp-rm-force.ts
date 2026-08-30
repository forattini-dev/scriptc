import { rm } from "node:fs/promises";

const absentClaim = `/tmp/scriptc-absent-claim-${process.pid}`;
await rm(absentClaim, { force: true });
console.log("reaped");
