# Community PR triage for the scriptc fork

Date: 2026-08-23
Query: Continue the fork mission by studying community PRs opened against the official repository.
Scope: All 35 PRs open in `vercel-labs/scriptc` at review time. The review uses PR descriptions, changed files, linked issues, current upstream source, and synthetic merges against `upstream/main` (`c9f532f`). It excludes deployment and security status, and it does not propose opening, commenting on, or otherwise changing anything in the Vercel repository.

## Executive Summary

Do not bulk-cherry-pick the open queue. It contains duplicate implementations, stacked branches, changes already superseded by later upstream commits, and several unchecked relaxations of compiler invariants.

The best near-term inputs for this fork are:

1. [#204 — void ternaries in discarded-value positions](https://github.com/vercel-labs/scriptc/pull/204): comprehensive differential and diagnostic regressions; supersedes the narrower #72; synthetic merge is clean.
2. [#117 — dynamic Promise runtime gating](https://github.com/vercel-labs/scriptc/pull/117): small linker correctness fix with a focused regression; synthetic merge is clean and current `main` still lacks its promise-type gate.
3. [#197 — tsconfig `paths` adoption for tsgo](https://github.com/vercel-labs/scriptc/pull/197): focused checker-side fix with a regression test; synthetic merge is clean. It should be followed by a separately tested resolver-side implementation informed by #200, not by importing the old stacked #42 branch.
4. [#51 — differential oracle cache keyed by environment](https://github.com/vercel-labs/scriptc/pull/51): test-infrastructure correctness with dedicated regression coverage; synthetic merge is clean.
5. [#146 — static DSP math](https://github.com/vercel-labs/scriptc/pull/146): useful general feature with differential and full-lane evidence, but broad enough to land only after the smaller correctness fixes.

The fork should study but rewrite/test independently: #41, #43, #48–#50, #130, #200, #201, and #225.

Avoid adopting as written: #198, #213, #217–#224, and the Windows pair #27/#202 until Windows becomes an explicit fork goal. #151 is a coherent but very large and niche MIDI vertical, so it should remain optional.

## Official Sources

- [Open pull requests](https://github.com/vercel-labs/scriptc/pulls) — authoritative queue and current PR state.
- [`vercel-labs/scriptc` main](https://github.com/vercel-labs/scriptc/tree/main) — authoritative current implementation used to detect superseded work.
- [Issue #33](https://github.com/vercel-labs/scriptc/issues/33) — open void-ternary correctness bug addressed by #72 and #204.
- [Issue #21](https://github.com/vercel-labs/scriptc/issues/21) — open FFI initializer bug addressed by #41.
- [Issue #25](https://github.com/vercel-labs/scriptc/issues/25) — open Windows native-build report behind #27/#202.
- [Issue #36](https://github.com/vercel-labs/scriptc/issues/36) — open coverage/runtime-surface report behind #130.
- [PR #159](https://github.com/vercel-labs/scriptc/pull/159) — later merged aarch64-musl work containing the compiler failure-detail helper proposed by #157.
- [PR #160](https://github.com/vercel-labs/scriptc/pull/160) — later merged the NaN false-edge correction represented by stale PR #141.

## Hotlinks

- [Top implementation candidate: #204](https://github.com/vercel-labs/scriptc/pull/204)
- [Small linker fix: #117](https://github.com/vercel-labs/scriptc/pull/117)
- [Modern tsconfig paths adoption: #197](https://github.com/vercel-labs/scriptc/pull/197)
- [Resolver follow-up input: #200](https://github.com/vercel-labs/scriptc/pull/200)
- [Oracle cache correctness: #51](https://github.com/vercel-labs/scriptc/pull/51)
- [Static math feature: #146](https://github.com/vercel-labs/scriptc/pull/146)

## Key Findings

### Tier A — validate and adopt into the fork

| PR | Why it is useful | Required handling |
|---|---|---|
| [#204](https://github.com/vercel-labs/scriptc/pull/204) | Fixes an open ICE while preserving lazy branch evaluation, narrowing, constant folding, and the IR invariant against void-valued ternaries. Adds corpus and diagnostic tests. | Cherry-pick onto a fork branch, run focused plain/sanitized tests, then the available full gate. Treat [#72](https://github.com/vercel-labs/scriptc/pull/72) as superseded. |
| [#117](https://github.com/vercel-labs/scriptc/pull/117) | Prevents valid checked-dynamic Promise programs from linking without `scr_async_dyn.c`. Adds a focused linker regression. | Re-run the regression on current main and audit whether every promise-typed IR node truly requires the gated translation unit. |
| [#197](https://github.com/vercel-labs/scriptc/pull/197) | Preserves project `paths` semantics when synthesizing tsgo configuration. Includes a red/green regression and applies cleanly. | Land checker adoption first; then cover lowering/dynamic-import resolution separately using lessons from #200. |
| [#51](https://github.com/vercel-labs/scriptc/pull/51) | Prevents stale Node-oracle cache hits when inherited environment changes output. Adds focused key-invalidation tests. | Rebase conceptually onto the current cache format and ensure the complete environment does not leak into logs or artifacts. |
| [#146](https://github.com/vercel-labs/scriptc/pull/146) | Adds static lowering for broadly useful scalar math with C/LLVM differential coverage and reported full plain/sanitized validation. | Land after correctness fixes; rebase manifest/snapshot changes onto current surfaces rather than accepting them mechanically. |

### Tier B — useful idea, rewrite or strengthen first

| PR | Assessment |
|---|---|
| [#225](https://github.com/vercel-labs/scriptc/pull/225) | Date array/island support is plausible and now covers both backends after review feedback, but the PR adds no regression tests. Reproduce each storage, Promise, stream, and island-crossing path before adopting. |
| [#41](https://github.com/vercel-labs/scriptc/pull/41) | Important open FFI correctness bug with extensive tests, but the old branch conflicts with current lowering. Port the test first, then reimplement against current symbol classification. |
| [#48](https://github.com/vercel-labs/scriptc/pull/48), [#49](https://github.com/vercel-labs/scriptc/pull/49), [#50](https://github.com/vercel-labs/scriptc/pull/50) | Well-scoped lowering improvements with focused C/LLVM tests. They are hundreds of upstream commits old; retain tests and re-derive implementation against current representations. |
| [#43](https://github.com/vercel-labs/scriptc/pull/43) | Compile-time two-argument `URL` resolution is small and useful, but the PR adds no test. Add valid, invalid, and non-literal diagnostics before porting. |
| [#130](https://github.com/vercel-labs/scriptc/pull/130) | Honest partial-shim coverage is valuable and tested, but review identified stale documentation. Update docs and re-audit the current builtin inventory. |
| [#200](https://github.com/vercel-labs/scriptc/pull/200) | Identifies genuine drift between checker and lowering resolvers, but mixes self-name/directory fixes with a paths registry and conflicts in current lowering. Split it into independently tested slices after #197. |
| [#201](https://github.com/vercel-labs/scriptc/pull/201) | Avoiding `RangeError` on huge diagnostic sets is useful, but a fixed count of 1000 has no direct regression and is only an indirect size bound. Prefer a deterministic rendered-byte budget with tests. |
| [#196](https://github.com/vercel-labs/scriptc/pull/196) | Correctly spots tsgo option-serialization gaps, but JSX typechecking does not establish that scriptc can lower TSX. Adopt only with a clear TSX policy and end-to-end diagnostics. |
| [#45](https://github.com/vercel-labs/scriptc/pull/45) and [#44](https://github.com/vercel-labs/scriptc/pull/44) | Small type/diagnostic improvements. Require a concrete regression before taking them; neither currently adds one. |

### Tier C — already superseded or duplicated

| PR | Reason |
|---|---|
| [#141](https://github.com/vercel-labs/scriptc/pull/141) | The NaN false-edge bug was subsequently fixed in merged [#160](https://github.com/vercel-labs/scriptc/pull/160); current main already uses branch-aware NaN clearing. |
| [#157](https://github.com/vercel-labs/scriptc/pull/157) | The failure-detail behavior was subsequently incorporated into merged [#159](https://github.com/vercel-labs/scriptc/pull/159); current main already retains stderr, stdout, and process-message fallback. |
| [#72](https://github.com/vercel-labs/scriptc/pull/72) | Same issue as #204, with narrower coverage and an earlier rewrite point. Prefer #204. |
| [#42](https://github.com/vercel-labs/scriptc/pull/42) | Old stacked branch contains unrelated URL, crypto, and ambient-type commits. Prefer focused #197 plus a new resolver slice informed by #200. |
| [#24](https://github.com/vercel-labs/scriptc/pull/24) | README output examples have since evolved; the old one-line patch conflicts with current documentation and has no present value. |

### Tier D — do not adopt as written

| PR family | Reason |
|---|---|
| [#217](https://github.com/vercel-labs/scriptc/pull/217) | Implements `key in jsval` as `getProp(...) !== undefined`, which is not JavaScript `in` semantics when an existing property stores `undefined`. |
| [#219](https://github.com/vercel-labs/scriptc/pull/219) | Raises a recursion/instantiation safety cap tenfold without a repository regression or a model showing the new bound is safe. |
| [#220](https://github.com/vercel-labs/scriptc/pull/220), [#221](https://github.com/vercel-labs/scriptc/pull/221), [#223](https://github.com/vercel-labs/scriptc/pull/223) | Broadly erase or suppress type/shape checks in dynamic lowering. They rely on private large-program claims rather than repository regressions and can hide real mismatches. |
| [#222](https://github.com/vercel-labs/scriptc/pull/222) | Replaces non-compilable dynamic imports with `Promise.resolve({})`; silently inventing an empty module namespace does not preserve Node failure/evaluation behavior. |
| [#213](https://github.com/vercel-labs/scriptc/pull/213), [#218](https://github.com/vercel-labs/scriptc/pull/218), [#224](https://github.com/vercel-labs/scriptc/pull/224) | Bundle multiple representation changes or depend on the unchecked JSVAL series without repository tests. Split into one red/green behavior per change. |
| [#198](https://github.com/vercel-labs/scriptc/pull/198) | Treats ambient-only side-effect imports as no-ops. A runtime without a CSS loader does not generally ignore such imports; preserving the differential contract requires an explicit asset policy, not silent deletion. |
| [#27](https://github.com/vercel-labs/scriptc/pull/27), [#202](https://github.com/vercel-labs/scriptc/pull/202) | Competing Windows approaches: runtime MSVC shims versus forcing/discovering MinGW for clang while special-casing zig. Choose only after defining the fork's Windows toolchain contract and adding current Windows CI. |
| [#151](https://github.com/vercel-labs/scriptc/pull/151) | Large 35-file native MIDI subsystem. It is well motivated and reportedly validated, but it is a strategic product feature rather than a maintenance fix. |

## API / CLI / Config Details

- #197 changes the synthesized tsgo configuration, not the entire module-resolution pipeline. Bare/dynamic lowering still needs its own parity coverage.
- #200 touches self-name exports, directory targets, and tsconfig paths in one PR; those are separate resolution contracts and should be tested independently.
- #204 preserves the public behavior of discarded `void` expressions while keeping consumed void ternaries fenced with a diagnostic.
- #117 changes runtime translation-unit gating only; it should not alter emitted program semantics or the public API.

## Version Notes

- The queue was compared with `upstream/main` at `c9f532f` on 2026-08-23.
- PRs #213–#225 were only one upstream commit behind at review time; most older candidates were 9–265 commits behind.
- A clean synthetic merge means Git can combine the text; it is not proof that the behavior remains correct.

## Gotchas

- Open state is not evidence that a change is still missing. #141 and #157 demonstrate stale open PRs whose core fixes landed through different merged PRs.
- Green historical CI does not validate compatibility with the current runtime/compiler representation.
- Several recent PRs report only `packages/compiler` build success. That is weaker than this repository's differential plain/sanitized contract.
- Stacked contributor branches can make one PR appear to change unrelated files; #42 is the clearest example.
- Dynamic-lane convenience fallbacks must still preserve Node-observable behavior. Empty namespace stubs and property-read approximations do not meet that bar.

## Open Questions

- Does this fork want Windows-native support as an explicit supported contract? If yes, choose MSVC, MinGW clang, zig, or a documented subset before porting #27/#202.
- Is static DSP math (#146) a near-term product priority, or should the fork remain focused on correctness and compatibility first?
- Should asset imports such as CSS have an explicit ignore/loader configuration, rather than the unconditional behavior proposed by #198?
- Should the internal research report be committed to the fork or remain local project context?

## Source-by-Source Notes

- [#204](https://github.com/vercel-labs/scriptc/pull/204): strongest open correctness PR by test depth and semantic explanation; clean synthetic merge.
- [#117](https://github.com/vercel-labs/scriptc/pull/117): smallest high-confidence missing fix; current `moduleUsesDynAsync` lacks the proposed promise-type branch.
- [#197](https://github.com/vercel-labs/scriptc/pull/197): modern focused replacement for the checker half of old #42.
- [#51](https://github.com/vercel-labs/scriptc/pull/51): durable harness correctness; needs rebasing onto the current cache schema.
- [#146](https://github.com/vercel-labs/scriptc/pull/146): broad but coherent feature with cross-backend coverage.
- [#141](https://github.com/vercel-labs/scriptc/pull/141) / [#160](https://github.com/vercel-labs/scriptc/pull/160): example of an open PR superseded by a later merged solution.
- [#157](https://github.com/vercel-labs/scriptc/pull/157) / [#159](https://github.com/vercel-labs/scriptc/pull/159): another superseded open PR; the current helper already implements its essential fallback behavior.

## Recommended Next Steps

1. Finish the fork-local #176 `process.argv` correctness fix already under diagnosis.
2. Port #204 into a dedicated fork branch, preserve original authorship, and run its focused corpus/diagnostic tests in plain and sanitized lanes.
3. Port #117 with its linker regression and inspect static-size impact.
4. Adopt #197, then create a separate resolver-parity change for the independently reproducible parts of #200.
5. Rebase #51's tests onto the current oracle-cache format.
6. Re-evaluate #146 only after the correctness queue is green.
7. Keep all resulting branches and PRs inside `forattini-dev/scriptc`; do not open or modify PRs in `vercel-labs/scriptc`.
