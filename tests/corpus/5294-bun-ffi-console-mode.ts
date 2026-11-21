// @rust-only
// @target bun
// @no-engine
/// <reference path="5294-bun-ffi-console-mode.d.ts" />

async function probe(): Promise<boolean> {
  const { dlopen } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
  });
  const input = kernel.symbols.GetStdHandle(-10);
  if (!input) {
    kernel.close();
    return false;
  }
  const mode = new Uint32Array(1);
  const read = kernel.symbols.GetConsoleMode(input, mode) !== 0;
  if (read) kernel.symbols.SetConsoleMode(input, mode[0] ?? 0);
  kernel.close();
  return read;
}

async function main(): Promise<void> {
  console.log(await probe());
}

void main();
