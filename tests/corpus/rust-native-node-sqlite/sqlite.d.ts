declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(filename: string, options?: { readOnly?: boolean; timeout?: number; allowExtension?: boolean; enableForeignKeyConstraints?: boolean; open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    setReadBigInts(enabled: boolean): void;
    setReturnArrays(enabled: boolean): void;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    iterate(...params: unknown[]): Iterable<unknown>;
  }
}
