# Node surface inventories

The **denominator** behind the compat profiles, derived mechanically from
Node's own generated API database (`all.json`) for every runtime in the
matrix — see `packages/compiler/src/compat/node-matrix.ts`.

The profiles under `packages/compiler/src/compat/` classify three slices
member by member, which answers *"is this member supported?"* but never *"how
much of Node is that?"*. These files answer the second question: what
documented classes exist, per module, per version, and what changed between
the two majors. Nothing here is classified — an added class is **not** a
support claim in either direction, and a class the compiler will never
implement counts toward the denominator exactly like one it already does.

| File | What it is |
| --- | --- |
| `node-<version>-classes.json` | Module-qualified class list for one runtime, with counts and the pinned source |
| `node-class-diff.json` | The mechanical delta between the matrix runtimes |

Regenerate with `pnpm inventory:node`; `pnpm inventory:node:check` fails on
drift without touching the network. The generator is
`scripts/node-surface-inventory.mjs`.

## What is pinned, and what is not committed

The source URL is pinned by **exact version** —
`https://nodejs.org/docs/v<version>/api/all.json`, never `/latest/` and never
a major alias — because those URLs move under you. Each artifact records the
byte length and SHA-256 of the `all.json` it was derived from, so a silently
republished upstream is detectable rather than assumed away.

The raw `all.json` downloads are ~8 MB each and are **cached, not committed**
(`node_modules/.cache/node-api/`). The derived inventories are the artifact
that matters — they are what a coverage dashboard consumes, and they are small
enough to read in a diff. Pass `--vendor-raw` if you want the upstream bytes
in-tree as well.

## Normalization worth knowing

Node's `name` for a class is prose, not an identifier: bare
(`EventEmitter`), already qualified (`events.EventEmitterAsyncResource`), or
carrying a superclause (`BroadcastChannel extends EventTarget`). The generator
normalizes to one bare identifier owned by the document that defines it.
Without that, a docs edit adding or removing an `extends` clause makes the same
class appear as both an addition and a removal.
