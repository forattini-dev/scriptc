declare module "bun:ffi" {
  type ConsoleHandle = object;
  interface ConsoleSymbols {
    GetStdHandle(kind: number): ConsoleHandle | null;
    GetConsoleMode(handle: ConsoleHandle, mode: Uint32Array): number;
    SetConsoleMode(handle: ConsoleHandle, mode: number): number;
  }
  export function dlopen(
    library: string,
    symbols: Record<string, unknown>,
  ): { symbols: ConsoleSymbols; close(): void };
}
