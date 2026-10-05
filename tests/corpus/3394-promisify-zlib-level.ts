// @rust-only
// @no-engine
import { promisify } from "util";
import { deflateRaw, inflateRaw } from "zlib";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);

async function check(level: number): Promise<void> {
  const source = Buffer.from("hello hello hello hello compression works");
  const packed = await pack(source, { level });
  console.log(level, packed.toString("hex"));
  console.log((await unpack(packed)).toString("utf8"));
}

async function run(): Promise<void> {
  await check(0);
  await check(6);
  await check(9);
}

void run();
