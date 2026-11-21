/// <reference types="node" />
import { createPrivateKey } from "node:crypto";

try {
  createPrivateKey("invalid").export({ type: "pkcs8", format: "pem" });
  console.log("missed");
} catch {
  console.log("caught");
}
