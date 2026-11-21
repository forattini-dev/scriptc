// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";

async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function* entries(): AsyncGenerator<{
  line: string;
  rawLine: string;
  lineStartOffset: number;
}> {
  yield { line: "entry", rawLine: "RAW", lineStartOffset: 7 };
}

async function destructured(): Promise<string> {
  let value = "";
  for await (const { line, rawLine, lineStartOffset } of entries()) {
    value = `${line}:${rawLine}:${lineStartOffset}`;
  }
  return value;
}

async function main(): Promise<void> {
  const child = Bun.spawn([executable, "ok"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  console.log(
    "for await",
    (await capture(child.stdout)).trim(),
    await destructured(),
  );
}

void main();
