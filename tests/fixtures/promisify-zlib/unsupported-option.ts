import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
const pack = promisify(deflateRaw);
void pack(Buffer.from("hello"), { strategy: 1 });
