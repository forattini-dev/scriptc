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
- **The Rust island.** `packages/runtime-rust/src/island_modules.rs`
  `include_str!`s the parts it can honestly serve and concatenates them
  against its own host bridge.

## Rules

- **Order is the contract.** `manifest.json` lists the parts in the order
  the C literal had them; the shims capture each other's closures, so
  reordering is a behavior change, not a cosmetic one.
- **Every part is a statement fragment**, not a module. `01-prelude.js`
  opens the `(host) => {` arrow and `31-epilogue.js` closes it; everything
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
| `29-net-http-tls-zlib` | the socket, server and zlib bridges |
| `30-process` | the process bridge |
| `31-epilogue` | `host.write` (the console wiring) |

Every other part is pure JavaScript over the engine's own builtins.
