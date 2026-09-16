// @rust-only
// effect/unstable/sql's SqlError as a kernel error handle: `new SqlError({ reason: classifySqliteError(...) })` is
// constructed and propagated (Redcode's sqlite layer never reads `reason`, `cause` or `isRetryable`), its `_tag` is
// "SqlError", and its message is the classify option verbatim.
import { Effect } from "effect";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";

const failing = (label: string): Effect.Effect<string, SqlError> =>
  Effect.gen(function* () {
    const cause = new Error(`${label} went wrong`);
    yield* Effect.fail(
      new SqlError({ reason: classifySqliteError(cause, { message: `Failed to ${label}`, operation: label }) }),
    );
    return "unreachable";
  });

const program = Effect.gen(function* () {
  const first = yield* Effect.exit(failing("execute"));
  console.log("first", first._tag);

  // The tag is what a program matches on, and the message is the classify option.
  const recovered = yield* failing("query").pipe(
    Effect.catchTag("SqlError", (error) => Effect.succeed(`caught ${error._tag}: ${error.message}`)),
  );
  console.log(recovered);

  const exported = yield* failing("export").pipe(
    Effect.catchTag("SqlError", (error) => Effect.succeed(error.message)),
  );
  console.log("exported", exported);

  // Constructed without options: effect leaves the message empty for an unclassified cause.
  const bare = new SqlError({ reason: classifySqliteError(new Error("plain")) });
  console.log("bare tag", bare._tag);

  const orElse = yield* failing("load").pipe(Effect.orElseSucceed(() => "fallback"));
  console.log("orElse", orElse);
});

Effect.runPromise(program).then(() => console.log("done"), (error) => console.log("error", String(error)));
