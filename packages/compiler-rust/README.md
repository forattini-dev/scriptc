# scriptc native compiler

This is the first entirely Rust compiler path. It directly links the Rust parser, binder and checker from [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) at commit `780dc512d64f40afebffa6a7028207649fb7ed1c`. The `goport_core` name describes the upstream port; it does not invoke Go. The dependency is pinned in `Cargo.toml` and `Cargo.lock` and retains its upstream MIT/Apache-2.0 licenses.

The pipeline is source → Theo's Rust frontend → scriptc IR v13 → native IR validation → Rust source → Cargo/rustc → executable. There is no TypeScript/Go compiler fallback and no JavaScript engine. Cargo and the Rust linker/toolchain are required to build output binaries. Primitive numeric formatting uses the Rust `ryu-js` crate, already fetched with the compiler dependency graph; output builds run offline.

The current subset accepts `.ts`, `.mts`, `.js` and `.mjs` files with initialized `let`/`const` identifiers, primitive numbers/strings/booleans, numeric arithmetic and comparisons, unary minus/boolean negation, local assignments, blocks, boolean `if`/`else`, type aliases/interfaces and ambient `console.log`/`console.error`. Symbol identities preserve shadowed bindings. Non-finite numbers, negative zero and decimal literal spelling use the existing IR encoding.

Each invocation checks one entry with an explicit strict ES2022 configuration and a minimal console declaration. Loading the application's tsconfig and linking imported modules are later migration steps.

Functions, imports, objects/arrays, loops, async operations, coercions, console format substitutions and lone UTF-16 surrogates are not ported yet. They produce TypeScript diagnostics or `SCN1001`; they never execute through another compiler or engine. Console calls with multiple arguments require a non-format literal when the first argument is a string. This executable does not yet compile the reddb applications or replace the existing CLI.

Build with the pinned Rust 1.98.0 toolchain:

```sh
cargo build --locked --manifest-path packages/compiler-rust/Cargo.toml
```

On Windows, the compiler is `packages/compiler-rust/target/debug/scriptc.exe`; on Unix it is `packages/compiler-rust/target/debug/scriptc`. `--version` reports the frontend revision, IR version and engine mode. The Windows binary output must have an `.exe` extension.

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

The dedicated CI job runs these contracts on Ubuntu and Windows. Migration remains incremental: extending this crate requires matching native differential fixtures and preserving compatibility with the IR v13 contract.
