import { constants } from "node:fs";
import { expect, test } from "vitest";
import { fsConstantValue } from "./fs-constants.js";

test("admitted flags agree with the host Node filesystem ABI", () => {
  for (const name of ["O_RDONLY", "O_WRONLY", "O_RDWR", "O_CREAT", "O_EXCL", "O_TRUNC", "O_APPEND"] as const) {
    expect(fsConstantValue(name, process.platform), name).toBe(constants[name]);
  }
});

test("cross compilation uses the destination's exclusive-lock mask", () => {
  for (const [platform, mask] of [["linux", 194], ["darwin", 2562], ["win32", 1282]] as const) {
    const flags = ["O_CREAT", "O_EXCL", "O_RDWR"].map((name) => fsConstantValue(name, platform));
    expect(flags).not.toContain(undefined);
    expect(flags.reduce<number>((value, bit) => value | (bit ?? 0), 0)).toBe(mask);
  }
  expect(fsConstantValue("O_CREAT", "unknown-platform")).toBeUndefined();
  expect(fsConstantValue("toString", "linux")).toBeUndefined();
});
