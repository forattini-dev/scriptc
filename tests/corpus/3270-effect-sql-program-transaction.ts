// @rust-only
// A Connection subtype behind a semaphore, and a program-managed transaction (as drizzle's effect session runs them):
// the statement must reuse the connection provided under transactionService instead of re-acquiring the permit.
import { Context, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as Statement from "effect/unstable/sql/Statement";

interface SqliteConnection extends Connection {
  readonly label: string;
}

const log: string[] = [];

const make = Effect.gen(function* () {
  const run = (query: string, params: ReadonlyArray<unknown> = []) =>
    Effect.sync(() => {
      log.push(`run ${query} [${params.join(",")}]`);
      return JSON.parse('[{"n":1}]') as Array<Record<string, unknown>>;
    });
  const connection: SqliteConnection = {
    execute: (query, params) => run(query, params),
    executeRaw: (query, params) => run(query, params),
    executeValues: (query, params) => Effect.map(run(query, params), (rows) => rows.map((row) => Object.values(row))),
    executeUnprepared: (query, params) => run(query, params),
    executeStream: () => {
      throw new Error("executeStream not implemented");
    },
    label: "sqlite",
  };
  const semaphore = yield* Semaphore.make(1);
  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });
  return yield* Client.make({ acquirer, compiler: Statement.makeCompilerSqlite(), transactionAcquirer, spanAttributes: [] });
});

const program = Effect.gen(function* () {
  const sql = yield* Client.SqlClient;
  const scope = yield* Scope.make();
  const conn = yield* Scope.provide(sql.reserve, scope);
  yield* conn.executeUnprepared("BEGIN", [], undefined);
  const inside = Effect.gen(function* () {
    const tx = yield* Effect.serviceOption(sql.transactionService);
    console.log("tx", tx._tag);
    const rows = yield* sql.unsafe<{ n: number }>("SELECT n FROM t").withoutTransform;
    console.log("rows", rows.length);
  });
  yield* inside.pipe(Effect.provideService(sql.transactionService, [conn, 0] as const));
  yield* conn.executeUnprepared("COMMIT", [], undefined);
  yield* Scope.close(scope, Exit.void);
  const after = yield* sql.unsafe<{ n: number }>("SELECT n FROM t WHERE n > ?", [0]).withoutTransform;
  console.log("after", after.length);
  for (const line of log) console.log(line);
});

const layer = Layer.effect(Client.SqlClient, make).pipe(Layer.provide(Reactivity.layer));
Effect.runPromise(program.pipe(Effect.provide(layer))).then(() => console.log("done"), (error) => console.log("error", String(error)));
