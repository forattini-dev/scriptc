// @rust-only
// @no-engine
import { Effect, FileSystem } from "effect";

const access: FileSystem.FileSystem["access"] = (path, options) => Effect.sync(() => {
  console.log(path, options?.readable === true);
});
Effect.runSync(access("first"));
Effect.runSync(access("second", { readable: true }));
