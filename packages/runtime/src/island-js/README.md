# island-js — the island's JavaScript bootstrap, shared by both islands

This directory holds the engine-agnostic JavaScript that boots a scriptc
island: the CommonJS require shim over the build-time module map, the Node
builtin shims, and the process bridge. It used to live inline in
`scr_island.c` as one 6,400-line C string literal; it is JavaScript, so it
now lives as JavaScript.

Two consumers read the very same bytes:

- **The C island.** `scripts/gen-island-bootstrap.mjs` concatenates the
  parts in `manifest.json` order and writes `../scr_island_js.h`, which
  `scr_island.c` includes. Run the generator after editing any part;
  `node scripts/gen-island-bootstrap.mjs --check` fails when the committed
  header is stale.
- **The Rust island.** The same generator concatenates the `rust`
  manifest's parts into `packages/runtime-rust/src/island_bootstrap.js`,
  which that crate `include_str!`s and calls with the host bridge in
  `packages/runtime-rust/src/island_host.rs`. It is generated INTO the
  crate rather than reached across packages because the crate publishes
  on its own, so a cross-package `include_str!` would resolve only by
  node_modules layout accident.

The named export lists the builtin ESM wrappers destructure are shared the
same way, from `builtin-exports.json` into `../scr_island_builtins.h` and
`packages/runtime-rust/src/island_builtin_exports.rs` — each island getting
the slice its own manifest registers.

## Rules

- **Order is the contract.** `manifest.json` lists the parts in the order
  the C literal had them; the shims capture each other's closures, so
  reordering is a behavior change, not a cosmetic one. Its `c` list is
  every part; its `rust` list is the subset whose host surface
  `island_host.rs` implements. A part missing from `rust` leaves its
  builtin unregistered, which is the island's does-not-provide throw — a
  fence, not a silently wrong answer.
- **Every part is a statement fragment**, not a module. `01-prelude.js`
  opens the `(host) => {` arrow and `32-epilogue.js` closes it; everything
  between is statements in that one scope. A part is not independently
  parseable, on purpose — the shims share `builtins`, `memo` and the
  require closure.
- **Documentation comments are block comments on their own lines.** The
  generator lifts exactly those back out as C comments, so no comment text
  ships in the binary and the embedded payload stays the bytes the engine
  has always parsed. A comment that must survive into the payload has to
  be a `//` line comment.
- **`host` is the only seam.** A part that reaches outside JavaScript does
  it through `host.*`; that is what lets the Rust island pick a subset.
  Parts with no `host` use at all are the pure shims, and those are the
  ones the Rust island serves first.

## Which parts need a host

| part | host surface |
| --- | --- |
| `03-path` | `host.path`, `host.platform` |
| `04-fs` | `host.fs`, `host.fsConstants` |
| `05-os` | `host.arch`, `host.homedir`, `host.hostname`, `host.ids`, `host.platform`, `host.signals`, `host.tmpdir` |
| `06-tty` | `host.columns`, `host.isatty`, `host.write` |
| `09-url` | `host.urlFromPath`, `host.urlToPath` |
| `12-crypto` | `host.digest`, `host.hmac` |
| `13-stream` | `host.platform` (the default highWaterMark only) |
| `15-util` | `host.pid`, `host.promiseState`, `host.write` |
| `26-constants` | `host.fsConstants`, `host.signals` |
| `29-zlib` | `host.zlib` |
| `30-net-http-tls` | `host.httpStart`/`httpWrite`/`httpEnd`/`httpDestroy`/`httpSetTimeout` (the client leg) and `host.srvCreate`/`srvListen`/`srvAddress`/`srvPort`/`srvClose`/`srvRes*` (the server leg) — gated INDEPENDENTLY, so a host may bridge one and fence the other |
| `30b-net-sockets` | `host.netConnect`/`netWrite`/`netEnd`/`netDestroy`/`netFlow`/`netOption`/`netPeer`/`netLocal` and `host.netServer*` — replaces `30a`'s fenced `node:net` when the host has real sockets |
| `31-process` | the process bridge |
| `32-epilogue` | `host.write` (the console wiring) |

Every other part is pure JavaScript over the engine's own builtins.
