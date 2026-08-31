// Node 24/26 one-shot crypto.hash: string input uses UTF-8 and the
// omitted output encoding returns a lowercase hexadecimal string.
import { hash } from "node:crypto";

console.log(hash("sha256", "abc"));
console.log(hash("sha256", "abc", "base64"));
console.log(hash("sha256", Buffer.from([0, 1, 2, 255])));
console.log(hash("sha1", "abc"));
