import { Readable } from "node:stream";

async function defaultBreak(): Promise<void> {
  const stream = Readable.from(["a", "b"]);
  stream.on("error", (error) => {
    console.log(
      "default error",
      error.name,
      (error as NodeJS.ErrnoException).code,
      error.message,
    );
  });
  for await (const chunk of stream) {
    console.log("default chunk", chunk);
    break;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(
    "default state",
    stream.destroyed,
    stream.errored?.name,
    (stream.errored as NodeJS.ErrnoException | null)?.code,
    stream.errored?.message,
  );
}

async function preservedBreak(): Promise<void> {
  const stream = Readable.from(["a", "b", "c"]);
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    console.log("preserved first", chunk);
    break;
  }
  console.log("preserved state", stream.destroyed, stream.errored);
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    console.log("preserved rest", chunk);
  }
  console.log("preserved end", stream.destroyed, stream.errored);
}

async function explicitIteratorMethod(): Promise<void> {
  const stream = Readable.from(["symbol", "unused"]);
  for await (const chunk of stream[Symbol.asyncIterator]()) {
    console.log("symbol chunk", chunk);
    break;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log("symbol state", stream.destroyed);
}

async function returnFromLoop(stream: Readable): Promise<void> {
  for await (const chunk of stream) {
    console.log("return chunk", chunk);
    return;
  }
}

async function returnCloses(): Promise<void> {
  const stream = Readable.from(["return", "unused"]);
  await returnFromLoop(stream);
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(
    "return state",
    stream.destroyed,
    (stream.errored as NodeJS.ErrnoException | null)?.code,
  );
}

async function throwCloses(): Promise<void> {
  const stream = Readable.from(["throw", "unused"]);
  stream.on("error", () => {});
  try {
    for await (const chunk of stream) {
      console.log("throw chunk", chunk);
      throw new Error("body failure");
    }
  } catch (error) {
    console.log("throw caught", (error as Error).message);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(
    "throw state",
    stream.destroyed,
    (stream.errored as NodeJS.ErrnoException | null)?.code,
  );
}

async function main(): Promise<void> {
  await defaultBreak();
  await preservedBreak();
  await explicitIteratorMethod();
  await returnCloses();
  await throwCloses();
}

void main();
