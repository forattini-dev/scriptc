# scriptc native compiler

This is the first entirely Rust compiler path. It directly links the Rust parser, binder and checker from [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) at commit `780dc512d64f40afebffa6a7028207649fb7ed1c`. The `goport_core` name describes the upstream port; it does not invoke Go. The dependency is pinned in `Cargo.toml` and `Cargo.lock` and retains its upstream MIT/Apache-2.0 licenses.

The pipeline is source → Theo's Rust frontend → scriptc IR v13 → native IR validation → Rust source → Cargo/rustc → executable. There is no TypeScript/Go compiler fallback and no JavaScript engine. Cargo and the Rust linker/toolchain are required to build output binaries. Primitive numeric formatting uses the Rust `ryu-js` crate, already fetched with the compiler dependency graph; output builds run offline.

The current subset accepts `.ts`, `.mts`, `.js` and `.mjs` files with initialized `let`/`const` identifiers, primitive numbers/strings/booleans, numeric arithmetic and comparisons, unary minus/boolean negation, local assignments, blocks, boolean `if`/`else`, type aliases/interfaces and ambient `console.log`/`console.error`. Symbol identities preserve shadowed bindings. Non-finite numbers, negative zero and decimal literal spelling use the existing IR encoding.

Named top-level synchronous functions accept required, optional and defaulted native value parameters and native value/void returns. Direct calls, hoisting, recursion, mutual recursion and parameter reassignment lower to the existing IR `call`/`return` contract. Parameters retain their matching entries in the IR locals table. Optional/defaulted slots use existing undefined unions; direct calls, aliases and callbacks fill omitted slots with undefined. Defaults run lazily in parameter order inside the callee, with access to earlier parameters and fresh object creation per call. The body receives a separate mutable binding that closures can share. Optional/defaulted arrays or functions, defaults that may produce undefined, and parameter TDZ access remain explicit refusals. Flat arrays of strings, numbers and booleans can be created, assigned, passed and returned using the existing typed array IR; indexed access, spreads, mutation and array console inspection are later migrations.

ESM source imports use the Rust frontend's resolved module symbols, including config-relative paths aliases and package imports. Named/default imports, namespace function calls, re-exports and imported primitive values are linked across `.ts`, `.mts`, `.js` and `.mjs` source modules. Modules initialize once in DFS evaluation order, including cycles with hoisted function calls and initialized native values; reads before initialization are refused. `import type` dependencies are erased. Functions may call imported functions but cannot capture module variables yet.

The compiler discovers the closest `tsconfig.json` above the entry, or accepts `--project <file-or-directory>`. The upstream Rust parser preserves JSONC, `extends`, module resolution, paths, libs and Node/Bun type environments. Checking roots are the selected entry and project ambient declarations; executable dependencies are loaded by the resolver. Unrelated source/test roots are excluded. The native compiler overrides only `noEmit` and the checker worker count, and never edits the project. Invalid projects fail without fallback. Sources without a project use the standalone strict ES2022/ESNext configuration and a minimal mergeable console declaration.

For ESM packages that publish declarations separately from JavaScript, the public imports are typechecked first. A second Rust program resolves implementation exports with `noDtsResolution`, JavaScript loading and unrestricted package inference depth. That implementation AST supplies native lowering; unsupported bodies are refused. No user JavaScript is run during compilation. The `rust-native-package` differential fixture checks a `.d.mts`/`.mjs` package, aliases, module initialization and a local TypeScript dependency.

The two program views now share portable native function contracts. Matching the resolver's import/reexport edges connects declaration modules to runtime modules even when their package export paths and directories differ. Export aliases resolve to the actual implementation declaration; symbol names alone and guessed sibling filenames are never used as identity. Required/optional/defaulted native parameters and native returns and exported arrow functions retain their published signatures, including callback and record types. Locals with no recoverable execution-view type can derive storage from a successfully lowered initializer, with every subsequent use checked against that native representation. Conflicting declarations, overloads, unsupported public any/unknown types, arity differences and incompatible implementation bodies are refused. Untyped private helpers and JS control-flow refinements not supplied by the checker remain limited.

The `rust-native-js-contracts/contracts.ts` fixture is explicitly executed by the native compiler differential suite, including a runtime-backed callback and an escaping closure from unannotated JS. The old TypeScript frontend still requires an engine for this package shape. The IR interoperability test bypasses that old frontend, compiles the native IR with the existing Rust backend without engine features, and compares its binary to Node; this is a test oracle, never a production compiler fallback.

Default JSON imports can supply static string/number/boolean fields, including nested field reads such as `pkg.version`. General JSON aggregate values and mutations are refused until their native record/array representation is ported.

Closed, acyclic data records support nested object literals, required record parameters/returns, shorthand properties, reads, assignments and shared aliases. Structurally equal shapes are interned into the existing IR record layouts. Generated Rust uses `Rc<RefCell<...>>` to preserve object identity and mutation; reads release their borrow before the next operand evaluates, and field initializers retain source order. Optional fields carry an undefined union arm and omitted literal fields retain the IR absence marker. Index signatures, recursive layouts, accessors/methods, prototype setters, record spreads and width projections between different layouts remain refused.

Native tagged unions represent supported primitive/record arms, including optional and nullable fields. Literal unions with the same primitive representation are widened to that representation. Explicit `null`/`undefined` comparisons, checker-proven single-arm narrowing, payload equality, boolean short-circuit operations and boolean conditional expressions use the existing IR union/logical/ternary nodes. Union subsets requiring re-tagging, standalone unit storage and nullable arrays remain outside this subset. The `rust-native-records` fixture exercises BuildInfo-style returns, launch-probe-style nullable inputs and platform-style string domains without running any reddb application.

The first native Node calls are `path` join/resolve/normalize/dirname/basename/extname/isAbsolute/relative (including explicit posix/win32 variants), `fs.existsSync`, `os.homedir`/`tmpdir`/`platform`, and `process.cwd`/`platform`. They use existing IR `libCall` nodes and the memory-safe Rust runtime with `default-features = false`; no island feature is enabled. Other registered builtin imports may be unused, but unsupported calls are named refusals. Loading Node/Bun declarations does not itself implement their runtime APIs.

Synchronous function values use the existing IR `func`, `closure` and `callValue` contract. Named function references preserve identity; anonymous arrow/function expressions create fresh closures. Captured native variables share boxes, including reassignment, escaping closures and transitive captures. Contextually typed lambdas can ignore trailing arguments and discard expression-body results for void callbacks. Function-valued captures, function fields/union arms, named function expressions, forward captures and general function-signature adaptation remain refused; these boundaries avoid introducing uncollected reference cycles. Function signatures are owned compile-time type trees.

Nested function declarations, generic/async functions, rest parameters, CommonJS constructs, classes, general array operations, loops, async operations, general coercions, console format substitutions and lone UTF-16 surrogates are not ported yet. They produce TypeScript diagnostics or `SCN1001`; they never execute through another compiler or engine. Console calls with multiple arguments require a non-format literal when the first argument is a string. This executable does not yet compile the reddb applications or replace the existing CLI.

Build with the pinned Rust 1.98.0 toolchain:

```sh
cargo build --locked --manifest-path packages/compiler-rust/Cargo.toml
cargo fetch --locked --manifest-path packages/runtime-rust/Cargo.toml
```

On Windows, the compiler is `packages/compiler-rust/target/debug/scriptc.exe`; on Unix it is `packages/compiler-rust/target/debug/scriptc`. `--version` reports the frontend revision, IR version and engine mode. The Windows binary output must have an `.exe` extension.

Runtime-backed outputs currently require the sibling `packages/runtime-rust` sources at the compiler's build location. The fetch command preloads the pinned Rust dependencies; output builds remain offline. Dependency artifacts are shared under `packages/compiler-rust/target/native-programs` (override with `SCRIPTC_NATIVE_CARGO_TARGET_DIR`). Each build uses a distinct package/binary name, then copies its result into the temporary build directory before publishing, so concurrent builds cannot overwrite one another's executable. The program cache is separate from the compiler/test Cargo target lock.

The first fixture can be compiled on Windows with:

```powershell
packages/compiler-rust/target/debug/scriptc.exe build tests/corpus/rust-native-frontend/main.ts --out .scriptc/native-demo/main.exe
.scriptc/native-demo/main.exe
```

A binary build also writes `main.ir.json` and `main.rs` beside the executable. `--emit ir` and `--emit rust` write a single requested artifact instead. Failed checking/lowering does not publish artifacts or overwrite a previous executable.

The tests use the repository's Node 24.15.0 pin solely as the behavior oracle. Set `SCRIPTC_NODE_ORACLE` to its absolute path if the default `node` is a different version. The native differential test places executable traps for Node, Go, tsgo, tsc and Bun before the real PATH while compiling and running each fixture, and compares stdout, stderr and exit status byte for byte. The separate TypeScript interoperability test reads the generated JSON through the existing IR deserializer, validator and Rust emitter; none of these test oracles participate in the native compilation path.

```sh
cargo test --locked --manifest-path packages/compiler-rust/Cargo.toml -- --test-threads=1
cargo clippy --locked --manifest-path packages/compiler-rust/Cargo.toml --all-targets -- -D warnings
pnpm test:compiler-rust:ir
```

The parameter fixtures cover omitted and explicit undefined arguments, lazy defaults, null/falsy values, evaluation order, earlier parameter references, fresh records, aliases, contextual callbacks and captured default bindings. The shared corpus runs `rust-native-parameters/main.ts` through both frontends. `function-values.ts` additionally tests optional function values in the Rust frontend and executes its IR through the existing Rust backend; the legacy TS frontend still refuses that source form with SC1090.

The dedicated CI job runs these contracts on Ubuntu and Windows. Migration remains incremental: extending this crate requires matching native differential fixtures and preserving compatibility with the IR v13 contract.
