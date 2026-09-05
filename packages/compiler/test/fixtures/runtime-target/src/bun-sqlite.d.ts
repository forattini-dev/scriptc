declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    query(sql: string): { all(): unknown[] };
  }
}
