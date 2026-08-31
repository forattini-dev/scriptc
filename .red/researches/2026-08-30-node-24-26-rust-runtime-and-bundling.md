# Node 24/26 surfaces, Rust runtime, and dependency bundling

Date: 2026-08-30
Query: Inventory the final Node 24 and current Node 26 API surfaces, determine how their classes should map to the Rust runtime, identify useful native paths for Undici/Axios/Express, and evaluate bundling the complete dependency graph before native compilation.
Scope: Official Node.js 24.20.0 and 26.8.1 documentation, official Undici documentation, official Rollup and esbuild documentation, and the current scriptc Rust compiler/runtime. This is an architectural and prioritisation report; it does not claim that every documented Node class is already supported.

## Executive Summary

The right target is not one independent Rust implementation per JavaScript class. The official documentation currently exposes 266 documented class identities in Node 24 and 277 in Node 26. After normalising documentation-only namespace and inheritance-name changes, the inventories contain 223 and 234 unique class names respectively. Most classes are facades over a much smaller set of behaviours: byte storage, events, promises, scheduling, streams, URL parsing, filesystem handles, sockets/TLS, HTTP dispatch, cryptography, compression, and process isolation.

scriptc already has Rust modules for the most valuable shared primitives: bytes, events, promises, timers/event loop, URL values, readable/writable/duplex/transform streams, filesystem, HTTP client/agent, TLS, crypto, zlib, child processes, UDP, FFI, and diagnostics channels. The next phase should therefore close observable semantic gaps in those cores and add thin public projections for Node classes, not create a second runtime hierarchy. The new one-shot `crypto.hash()` lowering is the first completed slice of this approach.

Bundling is useful, but feeding a JavaScript bundle back into the TypeScript frontend as the canonical source is the wrong default: it can erase type information, rewrite module boundaries and names, and make diagnostics less faithful. The recommended design is typed graph linking inside scriptc: let the TypeScript compiler build and check the original source graph, lower each reachable module into typed scriptc IR, eliminate unreachable modules/exports there, and link that graph into one Rust program. Rollup or esbuild can be optional graph-discovery/compatibility tools and useful prototype oracles, but should not replace the typed frontend.

## Official Sources

- [Node.js 24.20.0 API index](https://nodejs.org/download/release/latest-v24.x/docs/api/index.html) and [machine-readable API](https://nodejs.org/download/release/latest-v24.x/docs/api/all.json)
- [Node.js 26.8.1 API index](https://nodejs.org/download/release/latest-v26.x/docs/api/index.html) and [machine-readable API](https://nodejs.org/download/release/latest-v26.x/docs/api/all.json)
- [Node.js 26 globals](https://nodejs.org/download/release/latest-v26.x/docs/api/globals.html), including Fetch and related web classes
- [Node.js streams](https://nodejs.org/download/release/latest-v26.x/docs/api/stream.html), [URL](https://nodejs.org/download/release/latest-v26.x/docs/api/url.html), and [Crypto](https://nodejs.org/download/release/latest-v26.x/docs/api/crypto.html)
- [Node.js 26 FFI](https://nodejs.org/download/release/latest-v26.x/docs/api/ffi.html) and [Virtual File System](https://nodejs.org/download/release/latest-v26.x/docs/api/vfs.html)
- [Undici Agent](https://github.com/nodejs/undici/blob/main/docs/docs/api/Agent.md) and [Undici Pool](https://github.com/nodejs/undici/blob/main/docs/docs/api/Pool.md)
- [Rollup introduction](https://rollupjs.org/introduction/) and [configuration options](https://rollupjs.org/configuration-options/)
- [esbuild build and bundling API](https://esbuild.github.io/api/#bundle) and [tree shaking](https://esbuild.github.io/api/#tree-shaking)

## Version Baseline

Node 24.20.0 is the current 24.x LTS documentation baseline. Node 26.8.1 is the current 26.x documentation baseline. Compatibility must be represented as profiles instead of one floating “latest Node” promise:

- `node24`: stable shared contract, suitable as the default compatibility floor.
- `node26`: shared contract plus Node 26 additions.
- `node26-experimental`: explicitly enabled surfaces whose official stability is still experimental.

The generated surface metadata must stamp the precise source versions. A moving `latest-v24.x` or `latest-v26.x` URL is appropriate for detecting drift, but release artefacts and corpus expectations must be pinned to concrete versions.

## Class Inventory

The official `all.json` files were traversed recursively across global classes, modules, and nested modules. Raw identities include their documentation module path. A second comparison normalised inheritance suffixes and ignored module-path editorial renames.

| Inventory | Node 24.20.0 | Node 26.8.1 |
|---|---:|---:|
| Documented module-qualified class identities | 266 | 277 |
| Normalised unique class names | 223 | 234 |

The meaningful Node 26 additions found by the normalised comparison are:

- `QuotaExceededError`.
- `RunStoresScope`, `BoundedChannel`, and `BoundedChannelScope` in diagnostics channels.
- `DynamicLibrary` in the experimental `node:ffi` module.
- `SyncHeapProfileHandle` in `node:v8`.
- `VirtualFileSystem`, `VirtualProvider`, `MemoryProvider`, and `RealFSProvider` in the experimental `node:vfs` module.
- `zlib.ZipBuffer`, `zlib.ZipEntry`, and `zlib.ZipFile`, currently experimental.

The two normalised removals are deprecated `assert.CallTracker` and legacy `SlowBuffer`. Several apparent raw additions/removals are documentation namespace changes, not runtime API changes; they must not generate compiler work automatically.

## Rust Mapping

The inventory should be mapped by behavioural kernel:

| Kernel | Public facades | Existing scriptc Rust base | Next useful work |
|---|---|---|---|
| Bytes and encodings | `Buffer`, typed arrays, `Blob`, `File`, text encoders/decoders | `bytes.rs`, `bytes_encoding.rs`, `text_decoder.rs` | Finish aliasing, slicing, transfer/copy, encoding errors, and web body conversions. |
| Events and cancellation | `EventEmitter`, `EventTarget`, `Event`, `AbortController`, `AbortSignal` | `event_emitter.rs`, event loop and promises | Unify listener bookkeeping and add abort propagation to timers, streams, and HTTP. |
| Streams | Node `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`; Web Streams controllers/readers/writers | `readable.rs`, `writable.rs`, `duplex.rs`, `transform.rs`, compiler stream model | Share queues/backpressure internally; expose Node and Web facades without copying chunks. |
| URL and query data | `URL`, `URLSearchParams`, `URLPattern` | `url_values.rs`, pinned Rust `url` crate | Complete mutation/serialization parity; implement URLPattern separately because it is pattern matching, not URL parsing. |
| Network and Fetch | sockets, TLS, HTTP classes, `Request`, `Response`, `Headers`, `FormData`, WebSocket/EventSource | `network.rs`, `http.rs`, `http_client.rs`, `http_agent.rs`, TLS modules | Add a reusable dispatcher/pool core, streaming bodies, abort, redirects, decompression, and protocol-aware connection reuse. |
| Crypto | Node crypto classes, Web Crypto `Crypto`, `SubtleCrypto`, `CryptoKey` | `crypto.rs`, `ring` | Expand algorithms and key objects only behind differential cases; reuse the same primitives for Node and Web Crypto. |
| Filesystem | `FileHandle`, `Dir`, `Dirent`, streams, stats; Node 26 VFS provider classes | filesystem modules and `rustix` | Stabilise ordinary `fs` first; model VFS as a provider trait only in the Node 26 experimental profile. |
| Compression | zlib streams and convenience functions; Node 26 ZIP classes | `zlib.rs`, `flate2` | Complete gzip/deflate stream parity before experimental ZIP containers. |
| Process and isolation | child processes, workers, VM, WASI | child-process modules; dynamic island support | Keep child-process support incremental; treat workers/VM/WASI as distinct execution models, not ordinary objects. |
| Native boundary | Node-API/C++ addons and Node 26 `DynamicLibrary` | Rust FFI compiler/runtime modules | Keep scriptc's typed FFI as the primary contract; Node 26 `node:ffi` is a separate, explicitly enabled compatibility facade. |

Every maintained compiler/runtime source file remains below 1,200 lines for readability. This is a per-file organisation constraint, not a cap on total runtime functionality or on generated output.

## Undici, Axios, and Express

Node documents that its global Fetch implementation is based on Undici and that custom dispatchers must follow Undici's `Dispatcher` contract. Undici's own model is particularly suitable for a native kernel: an `Agent` routes by origin and lazily reuses a per-origin `Pool` or `Client`; a `Pool` owns multiple clients for one origin. scriptc should recognise these stable shapes and lower them to one Rust dispatcher/pool implementation instead of compiling the library's connection machinery object by object.

The optimisation layers should be ordered as follows:

1. Global `fetch`, `Request`, `Response`, `Headers`, `FormData`, and abort signals over the shared Rust HTTP core.
2. Undici `Dispatcher`/`Agent`/`Pool`/`Client` facades over that same core.
3. Axios configuration normalisation and its Node HTTP adapter over the same request primitive, while preserving interceptors and error shapes in compiled user code.
4. Express router and middleware recognition, compiling static route tables and middleware chains into direct Rust dispatch where observable ordering and `next()` behaviour are proven by differential corpus cases.

Axios and Express optimisations must be opt-in semantic lowerings selected from proven call shapes. Unknown adapters, dynamic middleware mutation, monkey-patching, or reflective access must retain a general path or produce an honest diagnostic; the compiler must not silently reinterpret them.

## Bundling Decision

Rollup can combine an entry graph into a single output and statically exclude unused ESM code. CommonJS requires a plugin. esbuild can bundle literal and glob-resolvable imports, but preserves import forms it cannot resolve at compile time; its declaration-level tree shaking is strongest for ESM and does not provide the same result for CommonJS.

Those properties make both tools useful experiments, but neither solves scriptc's central requirement by itself. The desired pipeline is:

1. Resolve the project with TypeScript and Node package rules, retaining source files, symbols, types, package conditions, and diagnostics.
2. Lower reachable modules into typed scriptc IR while retaining module identity and source locations.
3. Link module bindings, side effects, CommonJS wrappers, dynamic-import boundaries, assets, and native builtins explicitly.
4. Eliminate unreachable modules and exports on the typed IR graph.
5. Generate one Rust crate/program and let Cargo/LLVM perform native dead-code elimination and linking.

An optional Rollup/esbuild probe may be used to compare resolved graphs, discover package incompatibilities, or compile dependencies that are intentionally treated as untyped JavaScript islands. It should produce metadata and test evidence, not become the default source-to-source stage before type checking.

## Corpus and Validation Strategy

The compatibility inventory becomes useful only when each supported public shape is backed by differential programs. Tests should be generated and curated by behavioural family, not by blindly mirroring every documentation heading:

- constructors, methods, getters/setters, iteration, inheritance, and error cases;
- sync, callback, Promise, stream, and abort variants where applicable;
- ESM, CommonJS, namespace import, destructuring, re-export, package exports, and dynamic import forms;
- Node 24 and Node 26 oracle lanes for behaviour that differs by profile;
- real slices extracted from `red-dev`, `red-skills`, and `tuiuiu.js`, reduced to stable regressions;
- Undici/Axios/Express cases that compare ordering, errors, bytes, headers, redirects, cancellation, connection reuse where observable, and process exit.

Development remains focused TDD under the repository resource limiter. The full sandbox gate is reserved for a shipping boundary, not run after every corpus addition.

## Recommended Execution Order

1. Generate and check in a versioned Node API inventory from the official JSON documents, including stability and first-version metadata, without hand-maintaining hundreds of rows.
2. Join that inventory to `surface-manifest.json` and report `static`, `dynamic`, `unsupported`, and absent forms per Node profile.
3. Finish the shared Rust kernels already present, starting with URL/bytes/streams/events and HTTP/Fetch; add one differential behaviour at a time.
4. Implement the Fetch/Undici dispatcher facade and validate it against real HTTP clients from the selected projects.
5. Add Axios adapter and Express router tracer bullets only after the HTTP/stream core is stable.
6. Prototype typed graph linking on one dependency-heavy `red-dev` or `red-skills` binary; compare its graph and binary with an esbuild/Rollup probe.
7. Add Node 26-only stable deltas. Keep experimental FFI, VFS, diagnostics scopes, heap profiles, and ZIP APIs behind explicit profile flags until their contracts settle.

## Gotchas

- “All classes” is an inventory requirement, not a mandate to duplicate every class in Rust.
- Documentation path/name changes create false API diffs unless identities are normalised.
- Pre-bundling emitted JavaScript can discard TypeScript information the compiler needs for static lowering.
- ESM tree shaking results cannot be assumed for CommonJS-heavy packages.
- A single-file bundle does not eliminate runtime-resolved imports, optional dependencies, native addons, assets, or filesystem-relative behaviour.
- Node 26 experimental APIs should not silently expand the Node 24 contract.

## Open Questions

- Should `node24` remain the default release profile while `node26` is opt-in until its non-LTS surface settles?
- Which real binary should be the first typed graph-linking tracer bullet: `redwall`, `redskilled`, or another small but dependency-heavy entry point?
- Should optional untyped dependency islands be permitted in otherwise static binaries, and how should their inclusion be displayed in build diagnostics?
