// @rust-only
// @no-engine
import { Effect } from "effect";

interface Access {
  readonly access: (path: string, options?: {
    readonly ok?: boolean;
    readonly readable?: boolean;
    readonly writable?: boolean;
  }) => Effect.Effect<void>;
}
const service: Access = {
  access: (path, options) => Effect.sync(() => {
    console.log(path, options?.readable === true);
  }),
};
Effect.runSync(service.access("first"));
Effect.runSync(service.access("second", { readable: true }));
