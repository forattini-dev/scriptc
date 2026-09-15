// @rust-only
// A native SqlClient provided through Layer.effect(SqlClient.SqlClient, …) and read back as a service.
import { Effect, Layer } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";

const log: string[] = [];

const make = Effect.gen(function* () {
  const run = (query: string, params: ReadonlyArray<unknown>) =>
    Effect.sync(() => {
      log.push(`run ${query} [${params.join(",")}]`);
      return JSON.parse('[{"n":1}]') as Array<Record<string, unknown>>;
    });
  const connection: Connection = {
    execute: (query, params) => run(query, params),
    executeRaw: (query, params) => run(query, params),
    executeValues: (query, params) => Effect.map(run(query, params), (rows) => rows.map((row) => Object.values(row))),
    executeUnprepared: (query, params) => run(query, params),
    executeStream: () => {
      throw new Error("executeStream not implemented");
    },
  };
  return yield* Client.make({ acquirer: Effect.succeed(connection), compiler: Statement.makeCompilerSqlite(), spanAttributes: [] });
});

const layer = Layer.effect(Client.SqlClient, make).pipe(Layer.provide(Reactivity.layer));

const program = Effect.gen(function* () {
  const sql = yield* Client.SqlClient;
  const rows = yield* sql.unsafe<{ n: number }>("SELECT 1 AS n").withoutTransform;
  console.log("n", rows[0]?.n);
  yield* sql.withTransaction(sql.unsafe("DELETE FROM t", []).raw);
  for (const line of log) console.log(line);
});

Effect.runPromise(program.pipe(Effect.provide(layer))).then(() => console.log("done"), (error) => console.log("error", String(error)));
