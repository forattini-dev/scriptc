import { Readable } from "node:stream";

const source = new Readable({ read() {} });
source.push("tail");
source.unshift("head-");
source.push(null);

console.log(source.read()?.toString());
