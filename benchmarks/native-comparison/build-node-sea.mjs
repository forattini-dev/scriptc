import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, resolve } from "node:path";

const [sourceArgument, outputArgument, workArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || !workArgument) {
  console.error("usage: node build-node-sea.mjs <source> <output.exe> <work-directory>");
  process.exit(2);
}

const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const work = resolve(workArgument);
mkdirSync(work, { recursive: true });
mkdirSync(dirname(output), { recursive: true });

let main = source;
if ([".ts", ".mts", ".cts"].includes(extname(source))) {
  main = resolve(work, "main.js");
  const transformed = stripTypeScriptTypes(readFileSync(source, "utf8"), {
    mode: "strip",
  });
  writeFileSync(main, transformed);
}

const config = resolve(work, "sea-config.json");
writeFileSync(
  config,
  `${JSON.stringify({
    main,
    mainFormat: "commonjs",
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  }, null, 2)}\n`,
);

const result = spawnSync(process.execPath, ["--build-sea", config], {
  cwd: work,
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
