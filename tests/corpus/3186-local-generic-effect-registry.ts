// @rust-only
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const values = yield* Effect.sync(() => new Map<string, string>());
  const register = <K extends "files" | "shell">(key: K, value: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      values.set(key, value);
      return key + ":" + (values.get(key) ?? "missing");
    });
  const invoke = (value: string): Effect.Effect<string> => register("files", value);
  console.log(yield* invoke("disk"));
  console.log(yield* register("shell", "terminal"));
  return [...values.keys()].join(",");
});
console.log(Effect.runSync(program));
