// @rust-only
// @no-engine
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);

async function badLevel(level) {
  let returned = false;
  try {
    const pending = pack("hello", { level });
    returned = true;
    await pending;
  } catch (error) {
    console.log("rejected", returned);
    console.log(error.name, error.code, error.message);
  }
}

/** @param {string} hex */
async function badData(hex) {
  try {
    await unpack(Buffer.from(hex, "hex"));
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}

async function run() {
  await badLevel(10);
  await badLevel(-2);
  await badLevel(Infinity);
  await badLevel("bad");
  await badLevel(null);
  await badData("");
  await badData("ff");
  await badData("cb48cdc9c9");
}

void run();
