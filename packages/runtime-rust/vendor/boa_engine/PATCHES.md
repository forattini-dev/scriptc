# scriptc patches over boa_engine 0.22.0

The crate is the registry tarball of boa_engine 0.22.0 with the changes
below. Regenerate by copying the registry crate and re-applying them.

## Inline cache: do not cache a slot across a shape change made by the accessor

`src/vm/opcode/get/property.rs`, `src/vm/opcode/set/property.rs`,
`src/vm/opcode/get/name.rs`: the cache fill after an internal
`__get__`/`__set__`/`__try_get__` paired the object's shape read AFTER
the call with the slot recorded BEFORE it. A getter (or setter) that
redefines its own property while it runs — zod v4's lazy `shape`
converts itself from an accessor into a data property — transitions the
object to another shape, and the cache entry then pairs the data shape
with the accessor slot, so the next read at that site calls the stored
value ("not a callable function"). The fill now skips when the shape
changed during the call (the set path keeps caching plain data slots,
whose shape change is the property insertion itself).

Reproduction (`cargo run --example island_eval --features island-eval`):

```js
function read(o) { return o.shape; }
const def = { type: "object", shape: { a: 1 } };
const sh = def.shape;
Object.defineProperty(def, "shape", { get: () => { const n = { ...sh }; Object.defineProperty(def, "shape", { value: n }); return n; } });
read(def); read(def); // second call threw before the fix
```

## Compiled-pattern cache in `RegExp` (src/builtins/regexp/mod.rs)

Every evaluation of a regex literal — and every `new RegExp(...)` — reaches
`compile_native_regexp`, which hands the pattern to `regress` to parse and
optimize from scratch. A literal inside a hot function is therefore
recompiled on every call: yargs' help layout (`cliui` → `string-width` →
`emoji-regex`, a multi-kilobyte pattern, plus `ansi-regex`) spent 56 of 60
profiler samples inside `compile_native_regexp`, 67 seconds for one
`--help`. The compiled `regress::Regex` is immutable and `Clone`, so the
patch keeps a bounded thread-local map from `(source, flags)` to the
compiled matcher (an `Rc` — a large pattern such as emoji-regex compiles to megabytes, and cloning it per evaluation allocated gigabytes during yargs' help) and shares it on later evaluations; the `RegExp` object
(lastIndex, identity) is still fresh per evaluation, as the spec requires.

Reproduce with `cargo run --example island_eval --features island-eval`:

```js
let n = 0;
for (let i = 0; i < 20000; i++) n += "a😀b".replace(/\p{Emoji_Presentation}/gu, "").length;
n
```

Unpatched, the loop takes seconds; patched, milliseconds.
