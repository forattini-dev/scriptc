// @rust-only
// Redcode's sqlite.bun.ts client shape: the native SqlClient decorated with Object.assign.
import { Effect } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const TypeId = "~@reddb-io/redcode-core/database/SqliteBun" as const;
type TypeId = typeof TypeId;

interface Config {
  readonly filename: string;
}

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId;
  readonly config: Config;
  readonly export: Effect.Effect<Uint8Array, SqlError>;
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>;
  readonly updateValues: never;
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const run = (query: string) => Effect.succeed(JSON.parse("[]") as Array<Record<string, unknown>>);
    const connection: Connection = {
      execute: (query) => run(query),
      executeRaw: (query) => run(query),
      executeValues: () => Effect.succeed([] as Array<unknown[]>),
      executeUnprepared: (query) => run(query),
      executeStream: () => {
        throw new Error("no");
      },
    };
    const acquirer = Effect.succeed(connection);
    const client = Object.assign(
      (yield* Client.make({ acquirer, compiler: Statement.makeCompilerSqlite(), spanAttributes: [["db.system.name", "sqlite"]] })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.succeed(new Uint8Array([1, 2])),
        loadExtension: (path: string) => Effect.sync(() => console.log("load", path)),
      },
    );
    return client;
  });

Effect.runPromise(Effect.gen(function* () {
  const client = yield* make({ filename: ":memory:" });
  console.log(client.config.filename);
  // Redcode never reads the exported bytes back; the member is stored and runs as an effect.
  yield* Effect.asVoid(client.export);
  console.log("export", "ran");
  yield* client.loadExtension("ext");
  const rows = yield* client.unsafe("SELECT 1").withoutTransform;
  console.log("rows", rows.length);
}).pipe(Effect.provide(Reactivity.layer))).then(() => console.log("done"));
