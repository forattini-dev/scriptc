# Typed map callbacks returning unknown

The npm-static Commander coverage contract exposed two SC9001 errors at
`cmd.options.map(opt => opt.short)`: the frontend emitted `dynFrom` for an
array of class instances and its callback without checking whether either
type could cross the dynamic boundary. A standalone typed class example
reproduced the same pair of errors.

The new `lower-array-map-dynamic.ts` helper keeps the source and callback
typed. It reads each source element and invokes the callback through its
original ABI, writing only the callback's dynamic result into a fresh dynamic
array. No source snapshot or dynamic callback adapter is required. This
preserves source/element identity, callback mutations and argument evaluation
order; zero through three declared callback parameters are supported, as is
the existing tuple snapshot path.

Traversal snapshots the initial length and reads elements fresh, like the
ordinary typed-map helper. Appended entries are not visited. This change does
not implement general sparse arrays or remove the typed indexed-read contract
when a callback truncates the source.

## Evidence

`/tmp/scriptc-typed-map-dynamic-20260909/` retains the before source, minimal
SC9001 reproduction, failed initial corpus run, build logs and focused checks.
The existing Commander expectation stays unchanged: its coverage contract
passes again without suppressing diagnostics or changing the selected backend.
Commander still has independent runtime fences; this is not full native
Commander acceptance.

Corpus `3140-native-typed-map-dynamic-result.ts` covers class and record
identity/mutations, callback arities, replacing and appending source entries,
exceptions, empty input, evaluation order and tuples. It requests no engine.
The existing `2850-array-map-unknown-result.ts` remains a regression control.

The first focused selection also ran `2850-namespace-object-value/main.ts`
and found a Rust refusal for a dynamic checked cast to a union. That failure
is retained in `rust.log` and remains a separate validation blocker.

Validation passed: both corpus programs on Rust (3140 with engine forbidden),
both on C and LLVM with sanitizers, all 32 npm-static tests in the plain lane,
and the five applicable statuses/Commander checks in the sanitized lane.
The workspace build, ESLint (zero errors), whitespace and file-size checks
also passed. The new module has no ESLint warnings; existing warnings remain
in the large container-lowering file, whose frozen ceiling decreased by 14 lines.

The current Redwall build passed 38 contracts and 26 render invocations with
Bun byte parity, without an engine, external FFI or runtime fences. Its
generated Rust is byte-identical to the preceding accepted build. Runtime
source/lock hashes are also unchanged. Full plain/sanitized acceptance remains
pending, including the separate namespace refusal above.
