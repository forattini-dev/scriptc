# Test harness

Two lanes over the same suite: plain (`pnpm test`) and sanitized (`SCRIPTC_SAN=1 pnpm test`, ASan + the runtime RC audit). Node is the oracle everywhere — corpus programs run under Node and as compiled binaries, and outputs must agree byte-for-byte. Both lanes must be green before a commit.

The Node that hosts Vitest/the TypeScript compiler and the Node that supplies
the semantic oracle are separate inputs. They are identical by default;
`SCRIPTC_NODE_ORACLE=/absolute/path/to/node` selects a different oracle. CI
keeps the full byte-exact gate on the `.node-version` Node 24 profile and also
builds/runs the compiler on Node 26 with the captured Node 24 executable as its
oracle. This separation is intentional: Node-major releases can disagree on
observable errors, and such differences must not be mislabeled as native
backend regressions.

One deliberate exception to raw byte-compare: `node:test` programs (tests/harness/node-test.test.ts over tests/fixtures/node-test) cannot live in the corpus because Node's spec reporter embeds a real duration in EVERY result line — no node:test program has deterministic stdout, under Node itself included. Those fixtures still run both lanes against the Node oracle, but with one documented normalization applied to both sides (durations, stack frames, the inspect property block); everything else — symbols, indentation, directives, summary counts, the failing-section "test at" locations and error messages — must match byte-exactly, plus exit-code parity against the fixture's `// @exit:` line. Fixtures never console.log inside test bodies: Node's reporter stream lags console output racily, so mixed programs aren't byte-comparable against any oracle.

The LLVM backend rides the same two lanes through its own dual-backend differential (tests/harness/llvm-differential.test.ts): every corpus program is ATTEMPTED through `--backend=llvm`; programs the tier claims must be byte-identical through both backends AND against the Node oracle (stdout always, stderr for exit-0 programs, exit codes), and programs outside the tier must refuse with exactly one SC3001 diagnostic naming the first unsupported IR construct — never wrong code, never a silent fallback. Tier membership is auto-discovered (attempt + catch the refusal), the survey's six trivial-tier programs are pinned as a floor, and the run prints the claimed count plus the refusal histogram (the next phase's queue). Under `SCRIPTC_SAN=1` the emitted .ll's `sanitize_address` attribute opts the LLVM-emitted functions into ASan instrumentation too.

The Rust backend rides a STRICT full-corpus lane (tests/harness/rust-differential.test.ts): every corpus program is compiled under an explicit `--backend=rust` pin and must match the Node oracle — stdout always, stderr for exit-0 programs, exit codes — with `SCRIPTC_RUST_HEAP_AUDIT=1` making a leaked heap object a visible stderr divergence. There is no tolerated-refusal tier: the Rust backend claims the whole corpus, so an SC3001 refusal fails its test (the run still prints a refusal histogram, and `SCRIPTC_RUST_REFUSALS=1` lists the programs, so a batch regression reads as one summary). New corpus programs join the lane automatically. The Rust backend refuses sanitizers, so the suite skips itself under `SCRIPTC_SAN=1`; generated-source shape assertions live in packages/compiler/test/emit-rust.test.ts alongside the backend's unit tests.

A third, env-gated lane runs the corpus AND the fixture sets with runtime legs (tests/fixtures/server, tests/fixtures/dgram, tests/fixtures/fetch) on LINUX: `SCRIPTC_LINUX=1 pnpm exec vitest run tests/harness/linux-differential.test.ts` cross-compiles every program via `zig cc` (`SCRIPTC_CC=zigcc`/`SCRIPTC_TARGET` in cc.ts) and byte-compares against a Linux Node oracle inside a Docker container — for the fixtures, both lanes, the per-case driver, and the fetch servers all run in-container. `SCRIPTC_LINUX_TARGET=<arch>-linux-gnu.2.36` runs the whole lane in Bookworm; `SCRIPTC_LINUX_TARGET=<arch>-linux-musl` runs it in Alpine. The container platform follows the triple (`linux/arm64` for AArch64, `linux/amd64` for x86_64; the latter uses Rosetta/qemu on Apple-silicon Docker). It skips entirely without the env var and is never part of the commit gate.

A fourth lane does the same on WINDOWS: `SCRIPTC_WIN=1 pnpm exec vitest run tests/harness/windows-differential.test.ts` cross-compiles for `x86_64-windows-gnu`, ships each .exe (plus the program source) to the Windows box over scp, runs BOTH sides there over ssh — the box's own Windows Node is the oracle — and byte-compares stdout/exit codes with nothing normalized. `SCRIPTC_WIN_FILTER=<regex>` narrows a run; the box alias is `windows-dev` (`SCRIPTC_WIN_HOST` overrides). Programs needing cross-gated features skip with the gate's reason, and the in-file `WINDOWS_SKIPS` list names what compiles but deliberately diverges on Windows (posix-shaped spawn programs whose /bin children are ENOENT on Windows Node too, uid/tty surfaces) — both lists are the port's worklist. Never part of the commit gate.

A fifth lane covers LIBRARY MODE across targets: `SCRIPTC_CROSS=1 pnpm exec vitest run tests/harness/library-cross.test.ts` cross-builds every K-fixture library profile (both emissions) for `aarch64-linux-gnu.2.36`, `x86_64-linux-gnu.2.36`, `aarch64-linux-musl`, `x86_64-linux-musl`, `x86_64-windows-gnu`, and `x86_64-macos`, then asserts per archive ON THE HOST: K1 symbol exactness (nm reads ELF/COFF/Mach-O alike), the K8 ambient audit, and that each fixture's probe LINKS against the target's libc — plus, on win32, the documented embedder system libs (advapi32/iphlpapi/ws2_32, cc.ts's unconditional executable set). With `SCRIPTC_LINUX=1`/`SCRIPTC_WIN=1` additionally set, the K2 scalar probe also EXECUTES per linux triple in its matching Docker distribution and on the Windows box; x86_64-macos is build-only by contract (the probe runs as a bonus when Rosetta is present). Needs zig on PATH; `SCRIPTC_CROSS_FILTER=<regex>` narrows the fixture list. Never part of the commit gate.

## Workflow

Iterate filtered, gate full: while developing, run just what you're touching (`pnpm exec vitest run tests/harness/differential.test.ts -t <name>` or a single test file); run the full lanes (`pnpm test`, then `SCRIPTC_SAN=1 pnpm test`) as the gate before committing.

### Builtin-class compatibility profiles

Each engine-free builtin-class slice has one versioned, data-only profile under
`packages/compiler/src/compat/`. They share the row algebra in
`profile-schema.ts` — statuses, placements, entry constructors, evidence keys,
the version axis — and are listed in `registry.ts`, which is what the surface
manifest iterates: adding a profile is one registry line plus its data module
and its conformance suite. Notes in the manifest are stamped with the runtimes
whose reflected census contains the row, so a row stamped with one major exists
on that major alone.

Schema pieces worth knowing before adding rows:

- the fence code is **per row** (`compatEntries("SC2020")` /
  `compatEntries("SC1090")`), because one surface can refuse a member and a
  whole expression shape with different codes;
- `placement` covers `prototype-setter` (writes are a separate claim from
  reads) and `instance` (own properties of a constructed object — usually an
  empty declared set, which is exactly what catches a runtime that starts
  stamping them);
- `inventory.sources` names how to reach an interface that is not a global
  constructor (a module export, or a prototype with no constructor object at
  all, such as an iterator result);
- `targets` is `{ primary, candidates }` — a **matrix**, not a pin (see below);
  `primary` is the runtime `.node-version` pins and whose label stamps shared
  manifest rows, and a candidate is added only with its own reflected census.
- an inventory row may carry `targets: ["node26"]`, the **version qualifier**,
  naming the target ids whose census contains that member. Omitting it means
  *every* target, so a shared row cannot be narrowed by forgetting an id.

The shared reflection probes live in `compat-census.ts`.

### The Node matrix gate

scriptc targets **Node 24 and Node 26 as first-class runtimes**. The matrix
lives in `packages/compiler/src/compat/node-matrix.ts` — one module the
profiles, the conformance suites, and the gate runner all read, so a runtime
cannot be in the gate without being in the contract.

```
pnpm gate:node-matrix          # every declared runtime, in sequence
pnpm test:conformance:node24   # one runtime by target id
pnpm test:conformance:node26
pnpm test:conformance          # the three suites under whatever `node` resolves
```

**This local gate IS the enforcement.** CI does not run on the fork, so
`pnpm gate:node-matrix` green under both runtimes is the evidence that the
dual-target claim holds; run it before committing anything that touches a
compat profile, the census probes, or the conformance suites. The runner
resolves each interpreter explicitly (an `SCRIPTC_NODE_NODE24` /
`SCRIPTC_NODE_NODE26` override, else the running interpreter, else the mise
install tree, else `mise which`) and asks each candidate its `--version`,
rejecting a mismatch — a moved symlink must not let the "Node 26 lane" run
Node 24 and report success.

Two rules keep the lanes meaningful, and they pull in opposite directions:

- **The census follows the HOST.** "What members does `URL` expose?" is a
  question about the runtime the suite runs on. The suites *select* their
  target from `process.versions.node` rather than asserting equality with one
  pin, so they are green under any declared runtime and red only when the host
  is in **no** declared target — which is the one thing that is genuinely a
  contract violation.
- **The semantic oracle stays PINNED to the primary.** A compiled binary
  reproduces one Node's observable behavior, error-message text included, and
  cannot reproduce two: Node 26 rewords messages Node 24 emits (AbortSignal.any's
  `ERR_INVALID_ARG_TYPE` is "signals cannot be converted to sequence." there and
  "signals can not be converted to sequence." here). So differential checks call
  `primaryOracleExecutable` from `node-matrix.ts` rather than using
  `process.execPath`, and `SCRIPTC_NODE_ORACLE` is how you deliberately go
  looking for divergences instead of tripping over them.

Adding a runtime to the matrix means **running the reflection under it** and
writing every disagreement down as a version-qualified row. Nothing in the
matrix may be filled in from a changelog.

### Fetch compatibility profile

The engine-free fetch/Web Streams slice has one versioned source of truth in
`packages/compiler/src/compat/fetch-profile.ts`. It pins the exact Node and
bundled Undici oracle, drives the lowering allowlists, projects every supported
operation into `packages/compiler/surface-manifest.json`, and names the
differential evidence for each operation and `RequestInit`/`ResponseInit` member. A new row
without a real fixture or registered generated scenario fails the profile
suite.

`pnpm test:fetch-conformance` generates a program from that profile and runs it
under the pinned Node plus both native backends. The default seed exercises
WebIDL argument conversion/order, AbortSignal events, and twelve valid
ReadableStream state-machine traces. Reproduce or widen a campaign with:

```bash
SCRIPTC_FETCH_CONFORMANCE_SEED=12345 \
SCRIPTC_FETCH_CONFORMANCE_TRACES=50 \
pnpm test:fetch-conformance
```

The same profile now carries the denominator, not just the supported rows.
It reflects the public constructor/static/prototype surface of AbortController,
AbortSignal, Headers, Request, Response, ReadableStream, its default reader,
and its default controller. Proxy-backed constructor probes record Node's exact
RequestInit and ResponseInit WebIDL dictionary reads (including runtime members
that may be newer than the installed declarations). Every item is classified:

- `static`: engine-free and tied one-to-one to a differential-evidence row;
- `dynamic-only`: fenced from static builds with SC2020, accepted under
  `--dynamic`;
- `unsupported`: SC2020 in both tiers; this is implementation work rather than
  an implicit omission;
- `out-of-scope`: reflection metadata such as `Symbol.toStringTag`, retained so
  the scope boundary is machine-readable.

The selected adjacent interface families excluded from the census carry
reasons too. A Node upgrade that adds/removes a public member or dictionary key
fails the focused suite until that member is classified. The static,
dynamic-only, and unsupported rows project into the shipped surface manifest;
filter `NODE24_FETCH_COMPAT_PROFILE.inventory.entries` by `status`/`owner` for
the next cohesive implementation queue.

### URL compatibility profile

`packages/compiler/src/compat/url-profile.ts` censuses the WHATWG slice —
`URL`, `URLSearchParams`, and the search-params iterator — under the same
pinned Node. `pnpm test:url-conformance` re-reflects those interfaces and holds
the profile to the census, to resolvable corpus evidence on every supported
row, and to the shipped manifest's status/fence/note for every projected row.

Two statuses in that profile are worth reading carefully. URL component
**writes** are their own rows (`prototype-setter`): the static tier lowers
reads only, so every writable component is refused even where its read is
supported. And the members the dynamic engine's emulated URL class provides —
`origin`, `port`, `hash`, `username`, `password`, `toJSON`, `URL.parse`,
`URL.canParse` — are `unsupported` rather than `dynamic-only`, because that
class serves island and npm JS: a compiled `URL` value never exposes them, with
or without `--dynamic`.

### EventEmitter compatibility profile

`packages/compiler/src/compat/events-profile.ts` censuses `node:events` under
the same pinned Node; `vitest run tests/harness/events-conformance.test.ts`
holds it to the same four checks. Three things are specific to this slice:

- EventEmitter is **not a global**. It is the first profile to use the schema's
  `sources.resolve` factory, and the suite asserts the factory is what reaches
  it — plus that Node still does `module.exports = EventEmitter`, so the module
  object and the class object are the same census.
- Because module and class are one object, five names — `once`, `on`,
  `listenerCount`, `getMaxListeners`, `setMaxListeners` — exist at BOTH
  placements, four of them with opposite statuses. Those class-value rows carry
  a `publishAs` override so the manifest never prints one name twice.
- The census is the first with a non-empty **instance** placement.
  `_events`/`_eventsCount`/`_maxListeners` are enumerable own properties of the
  prototype and of every constructed emitter — Node's pre-private-field
  internals — so all three are declared twice and refused with SC1090.

Every fence in that profile was verified by compiling a probe, not by reading
the lowering. The split is worth knowing: a class-value CALL whose name the
emitter also carries as an instance member reaches the emitter lowering and is
refused SC2020, while a call with no instance counterpart, and every plain
property read off the class value, is refused SC1090.

When Node changes, update `.node-version` and the profile's Node/Undici tuple
together, regenerate with `pnpm manifest`, then run the focused plain and
sanitized conformance lanes before the full sandbox gate. When the static fetch
surface changes, update the profile first; its evidence check makes the missing
fixture or generated scenario the implementation worklist.

Full-suite runs (`vitest run` with no filters) take one advisory machine-wide lock (a pidfile in the OS temp dir) so plain and sanitized suites queue instead of oversubscribing the CPU. Filtered and watch runs never wait. `SCRIPTC_NO_LOCK=1` opts out; stale locks from dead processes are stolen automatically.

Direct local runs default to two Vitest workers, two nested native compiler jobs per worker, and one Cargo job. C/LLVM and Rust build transactions additionally share two host-wide seats across processes and worktrees; a dead owner is reclaimed automatically. `pnpm limit` narrows every one of those controls to one seat. Their temporary build trees live under `~/.cache/scriptc/test-tmp` instead of a RAM-backed system `/tmp` when the shell has not selected its own `TMPDIR`. `SCRIPTC_TEST_WORKERS`, `SCRIPTC_NATIVE_WORKERS`, `SCRIPTC_NATIVE_HOST_WORKERS`, `CARGO_BUILD_JOBS`, `SCRIPTC_NATIVE_LOCK_DIR`, and `TMPDIR` override those defaults for CI or deliberate high-capacity runs.

## Build and oracle caches

Test runs are dominated by clang (~275 corpus programs × two lanes at -O2/-O1+ASan). The production content-addressed build cache and the harness's oracle cache make repeat runs fast. Tests pin them under `node_modules/.cache/scriptc-tests/cas` (gitignored; override with `SCRIPTC_CACHE_DIR`) instead of using the per-user default:

- **binaries** (`bin/`, cc.ts): key = resolved clang identity/version + target/compiler environment + implicit system-header dependency bytes + linker/assembler identities + runtime fingerprint (every runtime .c/.h + the vendor pin) + the full normalized command line + the emitted C bytes (byte-stable by project invariant). A hit skips native code generation and linking; the binary still RUNS live, so no comparison or sanitizer coverage is ever skipped. Each hit is checksum-verified. The sanitized lane's flags land in naturally distinct keys. FFI archive/object inputs and ambient system libraries always relink because their named files can hide mutable transitive dependencies.
- **library archives** (`lib/`, cc.ts): key = resolved clang and archiver identities/versions + target/compiler environment and implicit dependencies + runtime fingerprint + target/flags + gated runtime-source set + emitted program-TU bytes. A checksum-verified hit skips native code generation and `ar`.
- **library program objects** (`program-obj/`, cc.ts): generated library TUs compile into checksum-verified objects keyed independently of the tiny exact-source identity TU. A build-id-only miss reuses the large program object, compiles the identity getters, and rearchives; runtime/header/toolchain inputs remain part of the key and are rechecked before publication.
- **early executable frontend** (`early-exe/`, executable/early-cache.ts): exact executable repeats validate a fresh effective-compiler identity, the frontend's complete file/resolution snapshot, and the native dependency proof before restoring the emitted C/LLVM unit, optional IR, and final executable without spawning TypeScript, lowering, or performing full clang/linker discovery. Source/config/package edits, newly appearing resolution candidates, mode/target/compiler/FFI changes, runtime/toolchain updates, and corrupt payloads miss; a valid frontend hit with an invalid native proof restores only the TU and falls through to compileC's strict native cache.
- **early library frontend** (`early-lib/`, library/early-cache.ts): exact library repeats validate content hashes for every file the TypeScript frontend read plus recorded failed-resolution and directory-enumeration probes, then restore the generated C/LLVM unit, optional IR, sidecar, and native feature gates without spawning TypeScript or lowering again. TypeScript comment-only misses may restore compressed lowered IR after token equivalence checks; source locations and exact-source sidecar/build identities regenerate from current bytes. Semantic comments/directives, JavaScript comments, token/config/package edits, and newly appearing resolution candidates miss. The native archive tier still performs its own toolchain/runtime checks.
- **runtime objects** (`obj/`, cc.ts): per-flavor .o for the runtime sources, including a distinct `-DSCR_LIB` flavor, so an edited executable or library recompiles only the program's own translation unit before linking or archiving. Each object carries a verified digest; a damaged entry is rebuilt before it reaches the linker or archiver. Publication rechecks the runtime and implicit-toolchain fingerprints after compilation so a concurrent source/header edit cannot place new bytes under an old key. Compiles route through ccache when installed, silently falling back when not.
- **oracle results** (`oracle/`, differential.test.ts): Node's stdout/exit per program, keyed by program bytes + the spawned node's version + shim contents + invocation shape. Only the spawn is skipped; the comparison never changes. Real-time programs (setTimeout/setInterval/Promise.race — 18 of 298) are excluded and always spawn Node live: their stdout is a timer interleave that Node and the native binary only agree on under the same instantaneous load, so a cached verdict from one run must never meet a live native run from another.

Escape hatches: `SCRIPTC_NO_CACHE=1` bypasses every cache in both directions (no reads, no writes — the run behaves exactly like the uncached path). An explicitly empty `SCRIPTC_CACHE_DIR` does the same; a non-empty value overrides the production default. Eviction is a size-capped LRU sweep over each cache root (`SCRIPTC_CACHE_MAX_MB`, default 4096), run after the first write and periodically in long-lived processes; reads bump mtimes.

Compiler environment variables that can resolve mutable compilation inputs (`CPATH`, `SDKROOT`, clang config directories, and their peers) conservatively bypass persistent artifacts and runtime objects. Compiler wrappers do the same because they can inject inputs conditionally on the real source/object topology; direct Clang, Apple's system Clang shim, and `zig cc` retain caching. The compiler must remain available so every invocation rediscovers dependency selection. Opaque archiver wrappers rebuild library program members and archives while retaining runtime-object reuse; trusted platform archivers and `zig ar` retain complete archive hits. Link-only search variables and explicit native link inputs bypass complete executables but retain safe runtime-object reuse.

`pnpm test:cache-identity` (optionally `--san`) is the acceptance artifact: it runs the full suite uncached, cache-populating, and cached, then diffs every test's name/status/failure output between the cached and uncached passes and exits nonzero on any drift.

`pnpm build` is incremental (tsbuildinfo under `node_modules/.cache/scriptc-tsc/`); `pnpm build:fresh` is the clean-build escape.
