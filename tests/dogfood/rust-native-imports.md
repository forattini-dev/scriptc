# Native Rust local module imports

A literal `import("./module.ts")` can evaluate a compiled local ESM module
without an embedded JavaScript engine. The target joins the compiled graph;
the import schedules evaluation after the current microtask checkpoint.
Each call returns a new Promise, while the module evaluation and namespace
are cached separately. Configured local aliases use the same resolver.

Namespace reads use traced getters over the original module globals. Mutable
primitive exports stay live; entity-name default exports retain their snapshot
semantics. Declared function exports share a cached native wrapper, including
its function properties, across aliases and named re-exports. Keys follow the
Node 24 oracle: canonical array indexes first in numeric order, followed by
other export names in UTF-16 lexicographic order. Namespaces have null
prototypes and reject writes and extensions. Enumeration, JSON and
inspection read the exports rather than exposing the getter implementation.

Synchronous ESM evaluation records retain the original thrown value, including
failures shared through static dependencies and different importing modules.
Top-level await reuses the existing evaluation and cycle-root promises. The
runtime clears pending native module jobs during teardown. Unreached import
sites do not force an otherwise static executable to use the native loader.

## Behavioral witnesses

| Corpus | Contract |
| --- | --- |
| 3041 | Deferred evaluation, fresh import Promises, one namespace, live mutable exports, cached imports and cast aliases |
| 3042 | Aliases, default snapshots, readonly namespace, enumeration, JSON and inspection |
| 3043 | Shared failing dependency, exact Error identity, concurrent imports and retries, evaluation once |
| 3044 | Imported module with top-level await |
| 3045 | Top-level self-import remains pending and exits 13 |
| 3046 | Dynamically reached cycle uses the runtime evaluation root |
| 3047 | Nested microtask checkpoints, unit exports, destructuring and named static imports |

These programs select the Rust differential lane. C and direct LLVM explicitly
return SC3001 for this new native module IR; their existing embedded-engine
import route remains separate. Every new corpus entry uses `// @no-engine`,
enforced during compilation and checked against the successful execution
profile. API tests also prohibit the engine and execute an actual Rust binary,
verify local/promise/global aliases and `.then`, and pin
unsupported boundaries. Runtime tests cover queue order, completion adoption,
shared failure identity, reentrancy, teardown and namespace protection.

For the six normal-exit corpus programs, the differential harness compares
stdout, stderr and exit status with Node. Corpus 3045 instead checks stdout,
exit 13 and absence of the Rust heap-audit marker; the existing nonzero-exit
lane does not establish byte-for-byte stderr equivalence.

## Remaining boundaries

This slice accepts primitive exports, primitive unions, native dynamic handles
and declared functions with supported argument/result representations. Typed
records, arrays and other composite exports require a native reference view
that preserves identity and shared mutation; the current copy conversion is
refused. Class and generic exports, broader function signatures, callable
`then` exports, CommonJS namespaces, computed module paths, callable
JSON/coercion hooks and import attributes still have explicit boundaries.
JSON imports retain their separate route.

Runtime `export *` declarations in the imported namespace module are refused
with SC1090. A native/Node probe showed that the checker's raw symbol export
table omitted wildcard bindings: Node printed `bump,local,value`, while Rust
printed only `local`. The admission guard prevents that incomplete namespace
from compiling. Type-only wildcard exports and named re-exports remain
admitted; API regressions cover all three cases.

Converting a native namespace into typed records or Promise payloads that
would copy its exports is also refused. Local aliases and casts retain the
handle. Static namespace objects used as first-class values alongside native
imports are refused because their existing record representation cannot share the
native namespace identity. Named static imports remain usable. Broader namespace
reflection and runtime loading of arbitrary modules are not established.
The scheduling witnesses do not prove complete Node ordering against filesystem
I/O and timers. Passing these witnesses does not establish compilation of the
full RSP, red-dev or redcode applications, complete C/LLVM parity, or a performance
advantage. Rustc normally continues to use LLVM internally.

The repository's full plain and sanitized gates remain pending/red; focused
checks are a development checkpoint, not release certification.

## Checkpoint validation

All seven native import corpus programs pass with the engine prohibited,
subject to the documented stderr limit for the exit-13 witness.
The focused API/IR/backend run passes all 38 tests in seven files, including
an actual Rust executable with the engine prohibited. The existing C/LLVM
import, top-level-await and JSON selection passes 28 plain tests and 12
sanitized tests. These are selected regression checks, not whole-corpus
parity. Rust sanitizers are not covered by the C/LLVM sanitized lane.

The Rust runtime passes 180 tests and all-target Clippy with warnings denied
on its pinned Rust 1.98.0 toolchain. Workspace build and lint pass; lint reports
zero errors and 3,114 warnings, including successful source-ceiling and
generated-file checks. All seven new preflight/order records for 3041–3047
match a fresh check; unrelated baseline disagreements are retained.

Reproduce the focused commands from the repository root, using the resource
limiter and a private persistent cache:

```bash
export SCRIPTC_LIMIT_CPU=100%
export SCRIPTC_CACHE_DIR=/home/cyber/.cache/scriptc-rust-native-gate
export CARGO_TARGET_DIR=/home/cyber/.cache/scriptc/cargo-target

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  packages/compiler/test/native-import-*.test.ts \
  packages/compiler/src/backend/native-module-support.test.ts \
  packages/compiler/src/ir/validate-module-inits.test.ts --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/rust-differential.test.ts -t '304[1-7]-' --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/differential.test.ts tests/harness/llvm-differential.test.ts \
  -t '205[0-2]-|2606-|265[0279]-|266[0-3]-|2893-' --maxWorkers=1

SCRIPTC_SAN=1 pnpm limit -- env -u LD_LIBRARY_PATH pnpm exec vitest run \
  tests/harness/differential.test.ts tests/harness/llvm-differential.test.ts \
  -t '2050-|2652-|2660-|2661-|2663-|2893-dynamic-json' --maxWorkers=1

pnpm limit -- env -u LD_LIBRARY_PATH cargo +1.98.0 test \
  --manifest-path packages/runtime-rust/Cargo.toml
pnpm limit -- env -u LD_LIBRARY_PATH cargo +1.98.0 clippy \
  --manifest-path packages/runtime-rust/Cargo.toml --all-targets -- -D warnings
pnpm limit -- pnpm -r build
pnpm limit -- pnpm lint
```

The cache paths above identify this workstation; other hosts should use their
own private directories. Local evidence is retained in
`/tmp/scriptc-native-import-api-checkpoint.log`,
`/tmp/scriptc-native-import-corpus-checkpoint.log`,
`/tmp/scriptc-native-import-legacy-plain.log`,
`/tmp/scriptc-native-import-legacy-sanitized.log`,
`/tmp/scriptc-native-namespace-order-full.log` and
`/tmp/scriptc-native-namespace-order-clippy.log`. Build, lint and new baseline
checks are recorded in `/tmp/scriptc-native-import-build-checkpoint.log`,
`/tmp/scriptc-native-import-lint-checkpoint.log` and
`/tmp/scriptc-native-import-baselines-check.log`. The wildcard mismatch probe
is `/tmp/scriptc-native-import-star-probe.json`. These local artifacts are
not portable release proof.
