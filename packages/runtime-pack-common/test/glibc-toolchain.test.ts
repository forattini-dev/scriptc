import { expect, test } from "vitest";
import { glibcRuntimeToolchain } from "../scripts/glibc-toolchain.mjs";

test.each([
  ["x64", "x86_64-linux-gnu.2.36"],
  ["arm64", "aarch64-linux-gnu.2.36"],
])("pins the %s GNU runtime to its glibc floor", (architecture, target) => {
  expect(glibcRuntimeToolchain(architecture)).toEqual({
    minimumOs: "glibc 2.36",
    compiler: "zig",
    compilerArgs: ["cc"],
    archiver: "zig",
    archiverArgs: ["ar"],
    targetArgs: ["-target", target],
    compilerFlags: ["-fno-sanitize=undefined"],
    forbiddenArtifactStrings: ["__isoc23_", "__ubsan_"],
  });
});

test("rejects unknown GNU runtime architectures", () => {
  expect(() => glibcRuntimeToolchain("riscv64")).toThrow(
    "unsupported GNU runtime architecture: riscv64",
  );
});
