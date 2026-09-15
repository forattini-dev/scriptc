// The bun-types surface of bun:sqlite this fixture uses (bun-types declares the same shapes).
declare module "bun:sqlite" {
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
    safeIntegers?: boolean;
  }
  export interface Changes {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export class Statement<ReturnType = unknown, ParamsType extends unknown[] = any[]> {
    constructor(nativeHandle: any);
    all(...params: ParamsType): ReturnType[];
    get(...params: ParamsType): ReturnType | null;
    run(...params: ParamsType): Changes;
    values(...params: ParamsType): Array<Array<string | bigint | number | boolean | Uint8Array>>;
  }
  export class Database {
    constructor(filename?: string, options?: number | DatabaseOptions);
    run(sql: string, ...bindings: unknown[]): Changes;
    query<ReturnType = unknown>(sql: string): Statement<ReturnType>;
    prepare<ReturnType = unknown>(sql: string): Statement<ReturnType>;
    close(): void;
    serialize(): Uint8Array;
    loadExtension(extension: string): void;
  }
}
