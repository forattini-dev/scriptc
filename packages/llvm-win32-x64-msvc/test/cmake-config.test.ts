import { join } from "node:path";
import { expect, test } from "vitest";
import { cmakeGeneratorArgs, cmakeReleaseOutput } from "../scripts/cmake-config.mjs";

test("the default generator follows CMake's newest Visual Studio and targets x64", () => {
  expect(cmakeGeneratorArgs({})).toEqual(["-A", "x64"]);
});

test("explicit generators retain their native platform argument contract", () => {
  expect(cmakeGeneratorArgs({ CMAKE_GENERATOR: "Visual Studio 18 2026" })).toEqual([
    "-G",
    "Visual Studio 18 2026",
    "-A",
    "x64",
  ]);
  expect(cmakeGeneratorArgs({ CMAKE_GENERATOR: " Ninja Multi-Config " })).toEqual([
    "-G",
    "Ninja Multi-Config",
  ]);
});

test("release output has one generator-independent location", () => {
  const build = join("root", "build");
  const output = join(build, "bin");
  expect(cmakeReleaseOutput(build)).toEqual({
    configureArgs: [
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${output}`,
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${output}`,
    ],
    executable: join(output, "scriptc-llvm-codegen.exe"),
  });
  expect(cmakeReleaseOutput(build, { CMAKE_GENERATOR: "Ninja" }).configureArgs).toEqual([
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${output}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${output}`,
  ]);
});
