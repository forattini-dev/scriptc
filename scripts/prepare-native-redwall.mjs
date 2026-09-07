#!/usr/bin/env node
// Disposable adapters import original consumer sources. No renderer rewriting.
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { consumer: { type: "string" }, out: { type: "string" } } });
if (!values.consumer || !values.out) throw new Error("usage: node scripts/prepare-native-redwall.mjs --consumer ../red-dev --out /tmp/native-redwall");
const consumer = resolve(values.consumer);
const output = resolve(values.out);
const renderer = join(consumer, "src/redwall-render.ts");
const themes = join(consumer, "src/themes.ts");
const art = join(consumer, "assets/wallpapers/obsidian.png");
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
  theme: THEMES.obsidian,
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
save("benchmark.json", JSON.stringify({
  inputs: [renderer, themes, art, font, join(output, "input.json")],
  cases: [
    { name: "rust", command: [join(output, "native/program"), join(output, "input.json")], cwd: output, artifacts: ["output.png"], acceptance: join(output, "native/acceptance.json") },
    { name: "bun", command: [join(output, "bun-program"), join(output, "input.json")], cwd: output, artifacts: ["output.png"] },
  ],
}, null, 2) + "\n");
console.log(output);
