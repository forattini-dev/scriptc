import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

let pack = promisify(deflateRaw);
pack = promisify(inflateRaw);
void pack(Buffer.from("hello"));
