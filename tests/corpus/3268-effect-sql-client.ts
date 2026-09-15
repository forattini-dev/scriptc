// @rust-only
// The effect/unstable/sql client surface Redcode's SQLite layer builds (over a fake in-memory connection).
import { Context, Effect, Layer, Scope, Semaphore } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";

const log: string[] = [];
// Rows arrive untyped, as from bun:sqlite's `statement.all()`.
const rows: unknown = JSON.parse('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');

const make = Effect.gen(function* () {
  const compiler = Statement.makeCompilerSqlite();
  const run = (query: string, params: ReadonlyArray<unknown> = []) =>
    Effect.withFiber<Array<Record<string, unknown>>>((fiber) => {
      log.push(`run ${query} [${params.join(",")}] safe=${Context.get(fiber.context, Client.SafeIntegers)}`);
      return Effect.succeed((query.startsWith("SELECT") ? rows : []) as Array<Record<string, unknown>>);
    });
  const connection: Connection = {
    execute(query, params) {
      return run(query, params);
    },
    executeRaw(query, params) {
      return run(query, params);
    },
    executeValues(query, params) {
      return Effect.map(run(query, params), (all) => all.map((row) => Object.values(row)));
    },
    executeUnprepared(query, params) {
      return run(query, params);
    },
    executeStream() {
      throw new Error("executeStream not implemented");
    },
  };
  const semaphore = yield* Semaphore.make(1);
  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  return yield* Client.make({ acquirer, compiler, spanAttributes: [] });
});

const program = Effect.gen(function* () {
  const client = yield* make;
  const all = yield* client.unsafe<{ id: number; name: string }>("SELECT id, name FROM t WHERE id > ?", [0]).withoutTransform;
  console.log("rows", all.length, all[1]?.name);
  const values = yield* client.unsafe("SELECT id, name FROM t", []).values;
  console.log("values", JSON.stringify(values));
  const inTx = yield* Effect.serviceOption(client.transactionService);
  console.log("inTx", inTx._tag);
  yield* client.withTransaction(Effect.gen(function* () {
    const tx = yield* Effect.serviceOption(client.transactionService);
    console.log("inside tx", tx._tag);
    yield* client.unsafe("INSERT INTO t VALUES (?)", [3]).raw;
  }));
  yield* Effect.scoped(Effect.flatMap(client.reserve, (conn) => conn.executeRaw("PRAGMA x", [])));
  for (const line of log) console.log(line);
});

Effect.runPromise(program.pipe(Effect.provide(Reactivity.layer))).then(() => console.log("done"), (error) => console.log("error", String(error)));
