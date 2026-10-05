import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";

const pack = promisify(deflateRaw);
const unpack = promisify(inflateRaw);

async function run(): Promise<void> {
  const text = "hello ☃".repeat(64);
  const compressed = await pack(text, { level: 6 });
  console.log(compressed.toString("base64"));
  // Node-compressed bytes: qualify Rust decoding independently of its encoder.
  const restored = await unpack(Buffer.from("y0jNyclXeDSjOWOUMcognQEA", "base64"));
  console.log(restored.toString("utf8") === text);
}
void run();
