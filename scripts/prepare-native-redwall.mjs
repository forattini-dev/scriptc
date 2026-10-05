#!/usr/bin/env node
// Disposable adapters import original consumer sources. No renderer rewriting.
// Outputs: main.ts (the JSON-driven renderer entry to compile), fixture.ts (writes
// input.json for --theme), preload.ts (the Bun-oracle consumer-contract hook),
// differential.mjs (one input through `<oracle> main.ts` and the native binary,
// comparing status, stdout, stderr, PNG bytes and the decoded raster; the oracle
// is any Node or Bun executable) and benchmark.json (scripts/native-benchmark.mjs).
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { consumer: { type: "string" }, out: { type: "string" }, theme: { type: "string", default: "obsidian" } } });
if (!values.consumer || !values.out || !/^[a-z][a-z0-9-]*$/.test(values.theme)) {
  throw new Error("usage: node scripts/prepare-native-redwall.mjs --consumer ../red-dev --out /tmp/native-redwall [--theme obsidian]");
}
const consumer = resolve(values.consumer);
const output = resolve(values.out);
const theme = values.theme;
const renderer = join(consumer, "src/redwall-render.ts");
const themes = join(consumer, "src/themes.ts");
const art = join(consumer, `assets/wallpapers/${theme}.png`);
const font = join(consumer, "assets/fonts/redwall-firacode-subset.ttf");
for (const file of [renderer, themes, art, font, join(consumer, "tsconfig.json"), join(consumer, "node_modules")]) {
  if (!existsSync(file)) throw new Error(`missing consumer input: ${file}`);
}
mkdirSync(output, { recursive: true });
const specifier = (file) => JSON.stringify("./" + relative(output, file).replaceAll("\\", "/"));
const save = (name, source) => writeFileSync(join(output, name), source);
save("tsconfig.json", JSON.stringify({ extends: join(consumer, "tsconfig.json"), include: ["main.ts"] }, null, 2) + "\n");
if (!existsSync(join(output, "node_modules"))) symlinkSync(join(consumer, "node_modules"), join(output, "node_modules"), "dir");
save("main.ts", `import { readFileSync, writeFileSync } from "node:fs";
import { renderRedwall, type RedwallState, type RedwallYear } from ${specifier(renderer)};
import type { Theme } from ${specifier(themes)};
interface Input { art: string; font: string; output: string; theme: Theme; state: RedwallState; year: RedwallYear; }
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Input;
writeFileSync(input.output, renderRedwall({
  art: new Uint8Array(readFileSync(input.art)), font: new Uint8Array(readFileSync(input.font)),
  theme: input.theme, state: input.state, year: input.year,
}));
`);
save("fixture.ts", `import { writeFileSync } from "node:fs";
import { THEMES } from ${specifier(themes)};
writeFileSync(${JSON.stringify(join(output, "input.json"))}, JSON.stringify({
  art: ${JSON.stringify(art)}, font: ${JSON.stringify(font)}, output: ${JSON.stringify(join(output, "output.png"))},
  theme: THEMES[${JSON.stringify(theme)}],
  state: { workers: 3, version: "native-probe", address: "127.0.0.1", capacity: 8, queued: 2 },
  year: { year: 2026, elapsed: 224, days: 365, firstWeekday: 4 },
}));
`);
save("preload.ts", `import { afterAll, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as renderer from ${specifier(renderer)};
const original = { ...renderer };
const binary = process.env.SCRIPTC_NATIVE_REDWALL_BINARY;
if (!binary) throw new Error("SCRIPTC_NATIVE_REDWALL_BINARY is required");
let calls = 0;
mock.module(${JSON.stringify(renderer)}, () => ({
  ...original,
  renderRedwall(input: Parameters<typeof renderer.renderRedwall>[0]): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-redwall-contract-"));
    try {
      const art = join(dir, "art.png"), font = join(dir, "font.ttf"), output = join(dir, "result.png");
      const config = join(dir, "input.json");
      writeFileSync(art, input.art);
      writeFileSync(font, input.font);
      writeFileSync(config, JSON.stringify({ art, font, output, theme: input.theme, state: input.state, year: input.year }));
      const result = Bun.spawnSync([binary, config], { timeout: 300_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
      if (result.exitCode !== 0 || result.stderr.byteLength !== 0) throw new Error("native renderer failed: " + result.exitCode + ": " + result.stderr.toString());
      const actual = readFileSync(output);
      if (!actual.equals(Buffer.from(original.renderRedwall(input)))) throw new Error("native PNG differs from the original Bun renderer");
      calls++;
      return new Uint8Array(actual);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
}));
afterAll(() => {
  if (calls === 0) throw new Error("no native renderRedwall invocations were exercised");
  console.error("native renderRedwall invocations with Bun byte parity: " + calls);
});
`);
save("differential.mjs", `// Oracle differential for the adapter: run \`<oracle> main.ts input.json\` and \`<binary> input.json\`
// from one input, then compare exit status, stdout, stderr, PNG bytes and the decoded raster.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";

const { values } = parseArgs({ options: {
  binary: { type: "string" }, oracle: { type: "string", default: process.execPath }, input: { type: "string" },
  main: { type: "string" }, out: { type: "string" }, label: { type: "string", default: "oracle" },
} });
if (!values.binary || !values.input || !values.out) throw new Error("usage: node differential.mjs --binary program --input input.json --out dir [--oracle /path/to/node|bun] [--main main.ts] [--label name]");
const input = resolve(values.input);
const main = resolve(values.main ?? join(dirname(input), "main.ts"));
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const spec = JSON.parse(readFileSync(input, "utf8"));
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** Independent PNG decoder (8-bit, non-interlaced, colour types 0/2/4/6, filters 0-4). */
function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, header = null; const idat = [];
  while (at + 12 <= bytes.length) {
    const length = dv.getUint32(at), tag = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== dv.getUint32(at + 8 + length)) throw new Error(\`bad CRC in \${tag}\`);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (tag === "IHDR") header = body; else if (tag === "IDAT") idat.push(body); else if (tag === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new Error("no IHDR");
  const hd = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = hd.getUint32(0), height = hd.getUint32(4), depth = header[8], colour = header[9], interlace = header[12];
  if (depth !== 8 || interlace !== 0) throw new Error(\`unsupported PNG: depth \${depth} interlace \${interlace}\`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (!channels) throw new Error(\`unsupported colour type \${colour}\`);
  const raw = inflateSync(Buffer.concat(idat.map((p) => Buffer.from(p))));
  const stride = width * channels, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[dst + x - channels] : 0, b = y > 0 ? data[dst - stride + x] : 0, c = x >= channels && y > 0 ? data[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(\`bad filter \${filter}\`);
      data[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}
function run(name, argv) {
  const output = join(out, \`\${name}.png\`);
  const config = join(out, \`\${name}.input.json\`);
  writeFileSync(config, JSON.stringify({ ...spec, output }));
  const started = performance.now();
  const r = spawnSync(argv[0], [...argv.slice(1), config], { cwd: dirname(main), timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
  const elapsedMs = Math.round(performance.now() - started);
  writeFileSync(join(out, \`\${name}.stdout\`), r.stdout ?? ""); writeFileSync(join(out, \`\${name}.stderr\`), r.stderr ?? "");
  let png = null, raster = null, decodeError = null;
  try { png = readFileSync(output); } catch (e) { decodeError = \`no output: \${e.message}\`; }
  if (png) { try { raster = decodePng(new Uint8Array(png)); } catch (e) { decodeError = e.message; } }
  return { name, argv, exitCode: r.status, signal: r.signal, error: r.error?.message ?? null, elapsedMs,
    stdout: { bytes: (r.stdout ?? Buffer.alloc(0)).length, sha256: sha(r.stdout ?? "") }, stderr: { bytes: (r.stderr ?? Buffer.alloc(0)).length, sha256: sha(r.stderr ?? ""), text: (r.stderr ?? "").toString().slice(0, 2000) },
    png: png ? { bytes: png.length, sha256: sha(png) } : null,
    raster: raster ? { width: raster.width, height: raster.height, channels: raster.channels, sha256: sha(raster.data) } : null, decodeError, _raster: raster };
}
const oracleName = \`\${values.label}-\${basename(values.oracle)}\`;
const oracle = run(oracleName, [values.oracle, main]);
const native = run("native", [resolve(values.binary)]);
const diffPixels = oracle._raster && native._raster && oracle._raster.data.length === native._raster.data.length
  ? oracle._raster.data.reduce((n, v, i) => n + (v !== native._raster.data[i] ? 1 : 0), 0) / oracle._raster.channels : null;
for (const r of [oracle, native]) delete r._raster;
const report = {
  schema: 1, createdAt: new Date().toISOString(), input: { path: input, sha256: sha(readFileSync(input)) }, main, host: process.version,
  oracleVersion: spawnSync(values.oracle, ["--version"], { encoding: "utf8" }).stdout.trim(),
  oracle, native,
  comparison: {
    exitCode: oracle.exitCode === native.exitCode, stdout: oracle.stdout.sha256 === native.stdout.sha256, stderr: oracle.stderr.sha256 === native.stderr.sha256,
    pngBytes: !!oracle.png && !!native.png && oracle.png.sha256 === native.png.sha256,
    raster: !!oracle.raster && !!native.raster && oracle.raster.sha256 === native.raster.sha256, differingPixels: diffPixels,
  },
};
report.comparison.allEqual = report.comparison.exitCode && report.comparison.stdout && report.comparison.stderr && report.comparison.pngBytes && report.comparison.raster;
writeFileSync(join(out, "differential.json"), JSON.stringify(report, null, 2) + "\\n");
console.log(JSON.stringify({ oracle: report.oracleVersion, native: values.binary, ...report.comparison, oracleMs: oracle.elapsedMs, nativeMs: native.elapsedMs, oraclePng: oracle.png?.bytes, nativePng: native.png?.bytes }));
process.exitCode = report.comparison.allEqual ? 0 : 1;
`);
save("benchmark.json", JSON.stringify({
  inputs: [renderer, themes, art, font, join(output, "input.json")],
  cases: [
    { name: "rust", command: [join(output, "native/program"), join(output, "input.json")], cwd: output, artifacts: ["output.png"], acceptance: join(output, "native/acceptance.json") },
    { name: "bun", command: [join(output, "bun-program"), join(output, "input.json")], cwd: output, artifacts: ["output.png"] },
  ],
}, null, 2) + "\n");
console.log(output);
