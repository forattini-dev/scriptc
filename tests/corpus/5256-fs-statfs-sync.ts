/// <reference types="node" />
import { statfsSync } from "node:fs";

const snapshot = statfsSync(".");
console.log(
  snapshot.bsize > 0,
  snapshot.blocks >= snapshot.bavail,
  snapshot.bavail * snapshot.bsize > 0,
);
