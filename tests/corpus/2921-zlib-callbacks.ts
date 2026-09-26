// The default-options one-shot zlib family: string and Buffer inputs,
// worker-backed error-first callbacks, aliases/namespaces, and crc32.
// Compressed bytes are zlib-version-dependent, so every encoder is checked
// through a decoder and only stable format markers/results are printed.
import {
  crc32,
  deflate,
  deflateRaw,
  deflateSync,
  gunzip,
  gzip,
  inflate,
  inflateRaw,
  unzip,
} from "node:zlib";
import * as zlib from "node:zlib";

const text = "the quick brown fox jumps over the lazy dog ☃".repeat(20);
const raw = Buffer.from(text, "utf8");
const gzipAlias = gzip;

async function run(): Promise<void> {
  console.log("crc", crc32("hello"), crc32(Buffer.from("hello")), crc32("hello", 123));
  console.log("sync-string", zlib.inflateSync(deflateSync(text)).toString() === text);

  let returned = false;
  const zlibPacked = await new Promise<Buffer>((resolve, reject) => {
    deflate(text, (error, value) => {
      console.log("deflate", returned, error === null, value.length > 0);
      if (error) reject(error);
      else resolve(value);
    });
    returned = true;
    console.log("scheduled");
  });
  const zlibPlain = await new Promise<Buffer>((resolve, reject) => {
    inflate(zlibPacked, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("inflate", zlibPlain.equals(raw));

  const rawPacked = await new Promise<Buffer>((resolve, reject) => {
    deflateRaw(raw, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  const rawPlain = await new Promise<Buffer>((resolve, reject) => {
    inflateRaw(rawPacked, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("raw", rawPlain.equals(raw));

  const gzipPacked = await new Promise<Buffer>((resolve, reject) => {
    gzipAlias(text, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("gzip-header", gzipPacked.subarray(0, 2).toString("hex"));
  const gzipPlain = await new Promise<Buffer>((resolve, reject) => {
    gunzip(gzipPacked, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("gzip", gzipPlain.equals(raw));

  const autoPlain = await new Promise<Buffer>((resolve, reject) => {
    zlib.unzip(zlibPacked, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  console.log("unzip", autoPlain.equals(raw));

  await new Promise<void>((resolve) => {
    inflate(Buffer.from([1, 2, 3, 4]), (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("corrupt", err.name, err.code, err.message);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    unzip(gzipPacked.subarray(0, gzipPacked.length - 4), (error) => {
      const err = error as NodeJS.ErrnoException;
      console.log("truncated", err.name, err.code, err.message);
      resolve();
    });
  });

  try {
    crc32(raw, -1);
  } catch (error) {
    if (error instanceof Error) {
      console.log("crc-range", error.name, (error as NodeJS.ErrnoException).code, error.message);
    }
  }
}

void run();
