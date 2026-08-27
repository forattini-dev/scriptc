import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function expectRustMatchesNode(fixture: string, prefix: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [fixture]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}

test("Rust diagnostics_channel pub/sub matches Node", async () => {
  const fixture = resolve("tests/corpus/2094-diagnostics-channel.ts");
  await expectRustMatchesNode(fixture, "scriptc-rust-diagnostics-channel-");
});

test("Rust diagnostics_channel tracing callbacks match Node", async () => {
  const fixture = resolve("tests/corpus/2160-dc-tracing-channel.cjs");
  await expectRustMatchesNode(fixture, "scriptc-rust-diagnostics-trace-callback-");
});

test("Rust diagnostics_channel tracingChannel traceSync matches Node", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "scriptc-rust-diagnostics-tracing-source-"));
  const fixture = join(sourceDir, "tracing-sync.cjs");
  await writeFile(fixture, `
'use strict';
const dc = require('diagnostics_channel');
const assert = require('assert');

const tc = dc.tracingChannel('rust-sync');
console.log(tc.start.name, tc.end.name, tc.error.name);
console.log(tc.hasSubscribers, tc.start.hasSubscribers);
let events = [];
const handlers = {
  start: (m) => { events.push('start:' + m.step); },
  end: (m) => { events.push('end:' + (m.result === undefined ? '-' : m.result)); },
  error: (m) => { events.push('error:' + m.error.message); },
};
tc.subscribe(handlers);
console.log(tc.hasSubscribers, tc.start.hasSubscribers, tc.error.hasSubscribers);

const context = { step: 'ok' };
const result = tc.traceSync(function (value) { return this.base + value; }, context, { base: 40 }, 2);
console.log(result, context.result, events.join('|'));
events = [];

const boom = new Error('sync boom');
try {
  tc.traceSync(() => { throw boom; }, { step: 'bad' });
} catch (error) {
  assert.strictEqual(error, boom);
  console.log('same error:', error.message);
}
console.log(events.join('|'));
console.log(tc.unsubscribe(handlers), tc.unsubscribe(handlers), tc.hasSubscribers);

const collection = dc.tracingChannel({
  start: dc.channel('rust-coll:start'),
  end: dc.channel('rust-coll:end'),
  asyncStart: dc.channel('rust-coll:asyncStart'),
  asyncEnd: dc.channel('rust-coll:asyncEnd'),
  error: dc.channel('rust-coll:error'),
});
console.log(collection.start.name, collection.error.name, collection.hasSubscribers);
`);
  await expectRustMatchesNode(fixture, "scriptc-rust-diagnostics-tracing-");
});
