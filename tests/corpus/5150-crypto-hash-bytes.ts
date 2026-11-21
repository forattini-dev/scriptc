/// <reference types="node" />
import { createHash } from "node:crypto";

const bytes = Buffer.from([0, 1, 2, 255, 128, 0]);
console.log(createHash("sha256").update(bytes).digest("hex"));
