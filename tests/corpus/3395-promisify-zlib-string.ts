// @rust-only
// @no-engine
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);

async function run(): Promise<void> {
  const packed = await pack("hello ☃", { level: 6 });
  console.log(packed.toString("hex"));
  console.log((await unpack(packed)).toString("utf8"));
}

void run();
