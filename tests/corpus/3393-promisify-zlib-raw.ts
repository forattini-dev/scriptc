// @rust-only
// @no-engine
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);

async function run(): Promise<void> {
  const pending = pack(Buffer.from("hello"));
  void pending.then(() => console.log("packed"));
  void Promise.resolve().then(() => console.log("microtask"));
  console.log("scheduled");
  const compressed = await pending;
  console.log(compressed.toString("hex"));
  console.log((await unpack(compressed)).toString("utf8"));
}

void run();
