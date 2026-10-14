import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Honor backpressure without joining a compiler-scale artifact into one string. */
export async function writeTextParts(path: string, parts: Iterable<string>): Promise<void> {
  await pipeline(Readable.from(parts), createWriteStream(path, { encoding: "utf8" }));
}
