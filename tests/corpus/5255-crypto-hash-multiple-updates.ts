/// <reference types="node" />
import { createHash } from "node:crypto";

const first = "alpha";
const second = "beta";
console.log(createHash("sha256").update(first).update("\0").update(second).digest("hex"));
console.log(createHash("sha1").digest("hex"));
