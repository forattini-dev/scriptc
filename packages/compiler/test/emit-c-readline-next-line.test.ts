/* `for await (const line of rl)` in the C runtime, against Node.
 *
 * The corpus differential lanes close stdin immediately, so the only
 * shape they can pin is "empty input, loop ends" (corpus 2794). The
 * interesting halves of an async iterator are the ones that need real
 * bytes on fd 0: lines already buffered when the loop asks, a partial
 * last line, a close() landing mid-iteration, and a `question`
 * interleaved with the iterator — where Node's own split shows up (onend
 * emits 'line' DIRECTLY, so the iterator hears the leftover partial line
 * and a pending question never does).
 *
 * Node IS the expectation here, exactly like the differential lanes: each
 * program runs under Node and as a compiled binary over the same stdin
 * bytes, and stdout must match byte for byte.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NODE_COMPAT_MATRIX } from "../src/index.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { compile } from "../src/index.js";

// A SEMANTIC oracle: pinned to the compat matrix primary, never the host
// (tests/harness/node-matrix.ts explains why).
const oracleExecutable = primaryOracleExecutable(NODE_COMPAT_MATRIX);

interface RunResult {
  stdout: string;
  exitCode: number | null;
}

function run(file: string, args: string[], input: string): Promise<RunResult> {
  return new Promise((settle, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => settle({ stdout, exitCode }));
    child.stdin.end(input);
  });
}

/** Compiles `source` through the C backend and returns Node's output and
 * the binary's over the same stdin bytes. */
async function bothLanes(name: string, source: string, input: string): Promise<[RunResult, RunResult]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-c-readline-"));
  const entry = join(dir, `${name}.ts`);
  await writeFile(entry, source, "utf8");
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, name),
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? entry : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) throw new Error("unreachable: the compile assertion above failed");
  return await Promise.all([
    run(oracleExecutable, ["--experimental-strip-types", entry], input),
    run(result.binaryPath, [], input),
  ]);
}

const ITERATE = `import { createInterface } from "node:readline";

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    console.log("line", JSON.stringify(line));
  }
  console.log("done");
}

void main();
`;

const ITERATE_WITH_CLOSE_LISTENER = `import { createInterface } from "node:readline";

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("close", () => { console.log("close"); });
  for await (const line of lines) {
    console.log("line", JSON.stringify(line));
  }
  console.log("done");
}

void main();
`;

const ITERATE_THEN_STOP = `import { createInterface } from "node:readline";

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let seen = 0;
  for await (const line of lines) {
    seen += 1;
    console.log("line", JSON.stringify(line));
    if (seen === 2) {
      lines.close();
      console.log("closed");
    }
  }
  console.log("done", seen);
}

void main();
`;

test.each([
  ["several whole lines", "one\\ntwo\\nthree\\n"],
  // The last line has no terminator: Node's onend emits it as a 'line'
  // anyway, so the iterator sees it before the loop ends.
  ["a partial last line", "one\\ntwo\\nthree"],
  ["one line, no terminator", "solo"],
  // Empty input is corpus 2794's shape, kept here beside its neighbours.
  ["no input at all", ""],
  ["only terminators", "\\n\\n\\n"],
  ["CRLF terminators", "one\\r\\ntwo\\r\\n"],
  ["a held CR at the end", "one\\ntwo\\r"],
])("C readline for-await matches Node: %s", async (name, input) => {
  const [node, native] = await bothLanes("iterate", ITERATE, input);
  expect(native.stdout).toBe(node.stdout);
  expect(native.exitCode).toBe(node.exitCode);
});

test("C readline for-await orders the close event like Node", async () => {
  const [node, native] = await bothLanes(
    "iterate_close_listener",
    ITERATE_WITH_CLOSE_LISTENER,
    "one\ntwo\nthree",
  );
  expect(native.stdout).toBe(node.stdout);
  expect(native.exitCode).toBe(node.exitCode);
});

test("C readline for-await ends when the loop body closes the interface", async () => {
  const [node, native] = await bothLanes(
    "iterate_then_stop",
    ITERATE_THEN_STOP,
    "one\ntwo\nthree\nfour\n",
  );
  expect(native.stdout).toBe(node.stdout);
  expect(native.exitCode).toBe(node.exitCode);
});
