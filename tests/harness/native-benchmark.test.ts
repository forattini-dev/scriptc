import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const script = resolve(import.meta.dirname, "../../scripts/native-benchmark.mjs");
const linuxTest = process.platform === "linux" ? test : test.skip;

function benchmark(first: string, second: string, artifacts: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-benchmark-"));
  try {
    const spec = join(directory, "cases.json");
    const out = join(directory, "results");
    writeFileSync(spec, JSON.stringify({ cases: [
      { name: "first", command: [process.execPath, "-e", first], artifacts },
      { name: "second", command: [process.execPath, "-e", second], artifacts },
    ] }));
    const result = spawnSync(process.execPath, [script, "--spec", spec, "--out", out, "--runs", "2", "--warmup", "1"], { encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    return { status: result.status, report: JSON.parse(readFileSync(join(out, "benchmark.json"), "utf8")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

linuxTest("benchmarks repeated equivalent processes and excludes warmups from summaries", () => {
  const source = "require('fs').writeFileSync('image.bin', Buffer.from([0,255,128])); console.log('same')";
  const { status, report } = benchmark(source, source, ["image.bin"]);
  expect(status).toBe(0);
  expect(report.equivalence).toBe(true);
  expect(report.samples).toHaveLength(6);
  expect(report.samples.filter((s: { warmup: boolean }) => s.warmup)).toHaveLength(2);
  expect(report.samples.map((s: { candidate: string }) => s.candidate)).toEqual(["first", "second", "second", "first", "first", "second"]);
  expect(report.summary).toHaveLength(2);
  for (const summary of report.summary) {
    expect(summary.elapsedMs.min).toBeGreaterThan(0);
    expect(summary.peakRssKiB.min).toBeGreaterThan(0);
    expect(summary.cpuSeconds.min).toBeGreaterThanOrEqual(0);
  }
});

linuxTest("refuses timings when output bytes differ", () => {
  const { status, report } = benchmark("process.stdout.write('a')", "process.stdout.write('b')");
  expect(status).toBe(1);
  expect(report.equivalence).toBe(false);
  expect(report.summary).toBeNull();
  expect(report.error).toContain("output differs");
});

linuxTest("refuses artifact mismatches even with matching console output", () => {
  const { status, report } = benchmark("require('fs').writeFileSync('image.bin', 'a')", "require('fs').writeFileSync('image.bin', 'b')", ["image.bin"]);
  expect(status).toBe(1);
  expect(report.error).toContain("output differs");
});

linuxTest("refuses stale artifacts and failing commands", () => {
  const stale = benchmark("require('fs').writeFileSync('image.bin', 'a')", "", ["image.bin"]);
  expect(stale.status).toBe(1);
  expect(stale.report.error).toContain("artifact was not refreshed");
  const failed = benchmark("process.exit(2)", "");
  expect(failed.status).toBe(1);
  expect(failed.report.error).toContain("command failed");
});
