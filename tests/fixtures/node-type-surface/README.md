# node-type-surface fixture

A two-project workspace whose projects resolve DIFFERENT copies of `@types/node`: the entry project (`app/`) is typed by the real, old-layout `@types/node` 24.13.3 vendored under `tests/fixtures/node-types/node_modules` (the harness links it in as `app/node_modules` at test time), and the reached library project (`lib/`) carries its own `node_modules/@types/node` — committed test data trimmed to the NEW layout `@types/node` 25+ ships: `declare module "node:child_process"` is the primary module and `"child_process"` re-exports it, `ChildProcess` and `net.Server` are `class X implements EventEmitter` merged with `interface X extends InternalEventEmitter<...>`, and `node:events` owns the `export =`. The old layout declares every module the other way around.

What the fixture pins (see `tests/harness/node-type-surface.test.ts`):

- One Node type surface per program: the entry project's resolution wins. Loading both layouts into one checker program merges `node:events` with two `export =` assignments and `child_process`/`node:child_process` with each other's re-exports; under the forced `skipLibCheck` that collision surfaced only as user-site errors ("Property 'on' does not exist on type 'ChildProcess'", the same for `once`/`off` and for `net.Server`) in whichever project happened to lose the merge. With the rule, `lib/`'s `@types/node` copy stands down, `app/main.ts` attaches `child.on`/`child.once`/`server.on`/`server.once` listeners, and the compiled binary matches Node.
- `app/off.ts` attaches `server.off` and `child.off` listeners: preflight passes under the one surface, and the Rust lane's verdict on those members is pinned.
- A type error inside `lib/` (the project whose copy stood down) carries the hint naming both copies.

`lib/node_modules/@types/node` is deliberately NOT a complete `@types/node`: it declares only `node:events`, `node:child_process`, and `node:net` in the new layout, enough to collide with the real old-layout surface exactly as the real 25.x/26.x packages do.
