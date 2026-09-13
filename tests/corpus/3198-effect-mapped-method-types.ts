// @rust-only
// @no-engine
import { Context, Effect, FileSystem } from "effect";

type AccessOptions = NonNullable<Parameters<FileSystem.FileSystem["access"]>[1]>;
type Access = Pick<FileSystem.FileSystem, "access">;
class AccessService extends Context.Service<AccessService, Access>()("access-service") {}

const implementation: Access = {
  access: (path, options) => Effect.sync(() => {
    console.log(path, options?.ok === true, options?.readable === true);
  }),
};
const options: Readonly<AccessOptions> = { ok: true, readable: true };
const partial: Partial<AccessOptions> = { ok: true };
const program = Effect.gen(function* () {
  const service = yield* AccessService;
  yield* service.access("default");
  yield* service.access("readonly", options);
  yield* service.access("partial", partial);
});
Effect.runSync(Effect.provideService(program, AccessService, implementation));
