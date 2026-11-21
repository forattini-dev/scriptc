/// <reference types="node" />
import { createHash } from "node:crypto";

const files: Readonly<Record<string, string>> = {
  "metadata.json": "native metadata",
  "extension.js": "native extension",
};

console.log(
  createHash("sha256").update(JSON.stringify(files)).digest("hex"),
);
