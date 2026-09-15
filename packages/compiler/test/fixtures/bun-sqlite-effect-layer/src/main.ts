/// <reference path="./bun-sqlite.d.ts" />
// Redcode's Sqlite.Native shape: a bun:sqlite Database provided under a `Context.Service<Native, unknown>` and read back
// with `(yield* Native) as Database`.
import { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";

class Native extends Context.Service<Native, unknown>()("probe/SqliteNative") {}

const nativeLayer = Layer.effect(
  Native,
  Effect.gen(function* () {
    const native = new Database(":memory:");
    yield* Effect.addFinalizer(() => Effect.sync(() => native.close()));
    native.run("CREATE TABLE t (n INTEGER)");
    return native;
  }),
);

const program = Effect.gen(function* () {
  const native = (yield* Native) as Database;
  native.run("INSERT INTO t VALUES (7)");
  const rows = native.query("SELECT n FROM t").all() as Array<{ n: number }>;
  console.log("rows", JSON.stringify(rows));
});

Effect.runPromise(program.pipe(Effect.provide(nativeLayer))).then(() => console.log("done"), (error) => console.log("error", String(error)));
