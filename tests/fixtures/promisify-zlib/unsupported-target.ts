import { promisify } from "node:util";
import { gzip } from "node:zlib";
const pack = promisify(gzip);
void pack(Buffer.from("hello"));
