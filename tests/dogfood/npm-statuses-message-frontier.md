# Statuses message lookup frontier

The full plain gate stopped because the statuses fixture expected three
runtime fences while the current frontend reported two. The removed fence
was its internal message-map lookup. Before updating the expectation, a
fixture executed message, lowercase message and invalid-message lookups
under Node, C and Rust. Stdout, stderr and exit code matched without an
embedded engine.

The two remaining fences are unchanged: numeric and numeric-string call
paths return strings despite the package's numeric JSDoc return annotation.
Strict `allowEngine: false` admission still rejects those deferred paths.
The supported message path executes under the ordinary npm-static policy;
this is not strict native acceptance of every statuses path.

`npm-static.test.ts` now expects the two actual JSDoc contradictions and
executes `statuses-message-cli.ts` on C and Rust against Node. The Rust case
uses the heap audit and skips the unsupported sanitizer lane.

Initial evidence: `/tmp/scriptc-statuses-fence-20260909/`. Consolidated
validation: `/tmp/scriptc-typed-map-dynamic-20260909/`.

All 32 npm-static tests passed in the plain lane after the independent typed
map correction. The five applicable statuses/Commander checks also passed in
the sanitized lane; Rust execution is covered by the plain lane.
