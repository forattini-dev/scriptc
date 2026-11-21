declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: number | { readonly?: boolean; readwrite?: boolean; create?: boolean; safeIntegers?: boolean });
    serialize(): Uint8Array;
    close(): void;
  }
}
