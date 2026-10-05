import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
const pack = promisify(deflateRaw);
console.log(pack);
