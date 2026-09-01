import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectRustOutput(
  name: string,
  source: string,
  stdout: string,
  options: { dynamic?: boolean; extension?: "ts" | "mjs" } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `scriptc-rust-frontend-${name}-`));
  try {
    const entry = join(dir, `${name}.${options.extension ?? "ts"}`);
    await writeFile(entry, source);
    const result = await compile(entry, {
      backend: "rust",
      dynamic: options.dynamic ?? false,
      optimization: "dev",
      outDir: dir,
      outPath: join(dir, name),
    });
    expect(
      result.ok,
      result.ok ? undefined : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const run = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Rust keeps the concrete instantiation for generic methods and optional fields", async () => {
  await expectRustOutput("generic-instance", `
class Box<T> {
  value?: T;
  map<U>(value: U): Box<U> {
    const next = new Box<U>();
    next.value = value;
    return next;
  }
}
const numberBox = new Box<number>();
numberBox.value = 2;
console.log(numberBox.map("ok").value, numberBox.value);
`, "ok 2\n");
});

test("Rust reads elements from an any-array represented as checked dynamic", async () => {
  await expectRustOutput("dynamic-rest-read", `
function tag(...args: any[]): string {
  return String(args[0]);
}
console.log(tag\`hello\`);
`, "hello\n", { dynamic: true });
});

test("Rust marshals unknown-to-any arithmetic into the dynamic island", async () => {
  await expectRustOutput("dynamic-unknown-any", `
const parsed: unknown = JSON.parse('{"value": 41}');
const config: any = parsed;
console.log(String(config.value + 1));
`, "42\n", { dynamic: true });
});

test("Rust preserves exact fields on a checker-erased JavaScript class", async () => {
  await expectRustOutput("javascript-exact-class", `
let FlagError;
const once = (factory, value) => () =>
  (factory && (value = factory(factory = 0)), value);
const initialize = once(() => {
  FlagError = class extends Error {
    flag;
    constructor(flag) {
      super(String(flag));
      this.flag = flag;
    }
  };
});
initialize();
const error = new FlagError("--wat");
console.log(error.flag, error.message);
`, "--wat --wat\n", { extension: "mjs" });
});
