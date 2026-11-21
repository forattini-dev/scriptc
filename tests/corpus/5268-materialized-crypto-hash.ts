/// <reference types="node" />
import { createHash } from "node:crypto";

const hasher = createHash("sha256");
hasher.update(Buffer.from("hello"));
console.log(hasher.digest("base64"));
