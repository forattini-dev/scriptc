import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  ["signal duck type", "dgram.createSocket({ type: 'udp4', signal: { aborted: false } });"],
  ["signal prototype", "dgram.createSocket({ type: 'udp4', signal: { __proto__: { aborted: false } } });"],
  ["finished stream state", "finished({ _readableState: {} }, () => {});"],
  ["finished stream method", "finished({ on() {} }, () => {});"],
  ["finished web reader", "finished({ getReader() {} }, () => {});"],
  ["pipeline array iterable", "pipeline([], destination, () => {});"],
  ["pipeline string iterable", "pipeline('text', destination, () => {});"],
  ["pipeline pair", "pipeline({ readable: true, writable: true }, destination, () => {});"],
  ["pipeline thenable", "pipeline({ then() {} }, destination, () => {});"],
] as const)("keeps unsupported capabilities fenced: %s", (_name, statement) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-argument-literal-"));
  try {
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, `
      const dgram = require('node:dgram');
      const { finished, pipeline, PassThrough } = require('node:stream');
      const destination = new PassThrough();
      ${statement}
    `);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    expect(coverage.diagnostics.some(diagnostic =>
      diagnostic.code === "SC2020" || diagnostic.code === "SC3003"),
    JSON.stringify(coverage.diagnostics)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
