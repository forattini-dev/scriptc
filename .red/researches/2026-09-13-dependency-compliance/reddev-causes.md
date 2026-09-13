# red-dev / Redwall dependency compliance audit

The two runtime dependencies are **typed packages published as JavaScript ESM with their own `.d.ts` files**. The evidence does not support blaming untyped transitive npm packages for red-dev's native build refusal. Most recorded blockers belong to compiler admission/lowering; Redwall additionally has a missing source-preparation prerequisite.

This read-only audit uses compiler HEAD `30cde1be34c0eddc7d6a4a808796f5c56c851d58` (source checkpoint reported by root: `5e0830c2`). The retained 773/3-diagnostic admission attempts use older compiler `f1087c892c9fb38ad41c712417284be98dadfe7d`. **Those counts are historical, not a fresh current build result.** All 152 loaded red-dev runtime source hashes still match the retained baseline. No installs, consumer/compiler edits, builds, or benchmarks were performed.

## Installed packages and actual imports

| Package | Installed runtime | Declaration surface | Actual production imports | Native assessment |
| --- | --- | --- | --- | --- |
| `cli-args-parser@1.0.6` | `dist/index.js`, ESM; no executable TS shipped | `dist/index.d.ts`; `createCLI: (schema: CLISchema) => CLI` | `src/cli.ts:12` → package root | Own declarations and readable runtime resolve; current auto eligibility returns no exclusion reason |
| `tuiuiu.js@1.0.75` | 287 ESM `.js` files; no executable TS shipped | 287 `.d.ts` files, including root and hooks | Ten imports from `tuiuiu.js`; `createWizard` imported from `tuiuiu.js/hooks` in `src/tui-setup-model.ts:26` and `src/tui-setup.ts:30` | Both actual subpaths resolve runtime + own types; current auto eligibility returns no exclusion reason |

`red-dev@1.0.133` requests parser `^1.0.6` and pins tuiuiu `1.0.75`. Both installed manifests have **no dependencies, optionalDependencies, or peerDependencies**. TypeScript 5.9.3 resolves `createCLI`, `Box`, `Text`, `renderToString`, `prompt`, and `createWizard` to non-any signatures. Their runtime implementations are JS, so a backend still needs to infer/check/lower those implementations; declaration availability alone does not compile them.

An AST traversal starting at the package subpaths actually imported by the original red-dev source reaches one parser module and 224 tuiuiu modules. It finds **zero external npm dependency edges and zero nonliteral import/require edges**. All bare runtime edges are Node builtins. Parser uses `fs`, `os`, and `path`; the conservative tuiuiu graph also contains builtins such as `node:async_hooks`, `node:child_process`, `node:readline`, `node:worker_threads`, and `node:zlib`. This is syntax-level module reachability including barrel exports and conditional imports, not proof that all those APIs execute in a particular CLI command.

The `/hooks` distinction matters: the consumer already deliberately imports `createWizard` there, with comments about the root export in this installed version. Do not replace that real import graph with a root-only package assumption.

Evidence: [structured probe](/tmp/scriptc-dependency-compliance-20260913/reddev-probe.json), [current compiler resolution/eligibility](/tmp/scriptc-dependency-compliance-20260913/npm-eligibility.json). The full resolved paths, import sites, declaration locations, builtin edges, and hashes are retained in [reddev-causes.json](/tmp/scriptc-dependency-compliance-20260913/reddev-causes.json).

## What the retained diagnostics actually say

| Baseline category | Count | Interpretation |
| --- | ---: | --- |
| `SC2013` | 19 | npm package implementation/admission requires engine under this attempted path; not missing `.d.ts` |
| `SC2020` | 177 | Already-typed APIs or call forms lack native lowering |
| `SC2011` with literal `any` | 21 | Every site is a Bun `with { type: "text" / "file" }` asset import |
| Other `SC2011` | 5 | Typed `Provider`, `FullUpgradePlan`, array/union representations lack admission |
| `SC2004` | 294 | Propagated declaration blockers; not 294 separate root causes |
| Remaining diagnostics | 257 | Unsupported syntax/calling conventions, import reference transport, structural/union conversions, and related checks |

Default and `npmStatic: auto` attempts recorded identical 773 diagnostics and zero loaded npm runtime modules. The current compiler's resolver/eligibility check accepts the three dependency specifiers, but that check does not establish that their inference/preflight/lowering succeeds. The old result does not retain enough package-status detail to name an exact fallback cause; a fresh focused admission investigation is compiler work.

Examples of typed native API blockers include `Bun.spawn` (33 diagnostics), `Bun.write` (29), `BunFile.text` (18), `Bun.which` (15), subprocess `.stdout`/`.exited`, `spawnSync` options, `process.stdout.columns`, and `.splice` with three arguments. The diagnostic phrase “typed by @types/node” also appears for Bun declarations; the actual installed Bun surface is present. Adding TS annotations does not implement those runtime operations. Some calling-convention diagnostics may already be obsolete after later compiler commits; this audit did not rebuild the full entry.

Baseline sources: [red-dev default](/tmp/scriptc-all-binary-admission-20260913/red-dev__red-dev__default/build.json), [red-dev auto](/tmp/scriptc-all-binary-admission-20260913/red-dev__red-dev__auto/build.json), [admission checkpoint](/tmp/scriptc-redcode-identity-20260913/.red/checkpoints/2026-09-13-native-consumer-builds/admission.json).

## Asset types and one real consumer configuration issue

The original [shims.d.ts](/home/cyber/Work/reddb.io/red-dev/src/shims.d.ts) already declares string values for `.sh`, `.conf`, `.kdl`, `.png`, `.ttf`, and `.embedded`. Those declarations cover **20 of the 21** literal-any asset diagnostics. Its tsconfig includes the shim file. A bounded virtual TS probe confirms the font and shell imports are `string` with those original shims, and become `any` without them.

Current [program.ts](/tmp/scriptc-redcode-identity-20260913/packages/compiler/src/frontend/program.ts:452) constructs entry/ambient/runtime roots without adopting the project's tsconfig-included declaration roots. This points to compiler declaration adoption, followed by actual text/file resource lowering. Asking the consumer to add declarations it already has would not address that boundary. Correct types alone also cannot embed bytes or supply the runtime file paths expected from Bun's file loader.

The remaining `starship.toml` import explicitly requests **text contents**. Bun's generic `*.toml` declaration returns `any`, and the local shims do not specialize that text contract. With a working Bun type directive and the local shims, the virtual probe has no type diagnostics but this binding remains `any`. The project needs an accurate string contract at that asset boundary, and the compiler must honor the explicit loader attribute; blindly changing all parsed TOML values to string would be incorrect.

There is also a reproducible consumer setup mismatch: [tsconfig.json](/home/cyber/Work/reddb.io/red-dev/tsconfig.json) requests `types: ["bun-types"]`, while this pnpm install directly exposes `@types/bun@1.3.14` and keeps `bun-types@1.3.14` behind it. TypeScript resolution of `bun-types` from the consumer fails with TS2688. Using `types: ["bun"]` **only in the in-memory probe** resolves the installed public dependency and removes that options error. The consumer should align its type directive with its declared dependency or directly declare/install `bun-types` if intentional. No change was made. Scriptc already separately resolves `bun`, so this setup issue does not explain its entire historical native refusal.

## Why standalone Redwall reports three missing modules

[scripts/redwall-bin-main.ts](/home/cyber/Work/reddb.io/red-dev/scripts/redwall-bin-main.ts:22) is a staging template. Its imports `./redwall-render.ts`, `./redwall-font.ts`, and `./themes.ts` are supposed to resolve **after** [build-redwall-bin.sh](/home/cyber/Work/reddb.io/red-dev/scripts/build-redwall-bin.sh) copies it to `.red/tmp/redwall-build/src/main.ts`. Those siblings do not exist under `scripts/`; the staging tree is absent too. The entry imports `REDWALL_SUBSET_BYTES`, an export generated by that script; original `src/redwall-font.ts` exports only `REDWALL_SUBSET`.

Therefore the three retained `SC0001` errors are a **consumer preparation/entrypoint prerequisite**, not missing npm declarations or evidence that the compiler failed to resolve existing files. The standalone template itself only imports `node:fs` plus the missing relative sources; cli-args-parser/tuiuiu are not its immediate dependencies.

The consumer must provide the intended prepared source graph and assets, or maintain a canonical entry whose imports resolve from its actual location. The existing preparation script was not run: it also replaces brand code, stubs type modules, substitutes typed arrays/arithmetic, changes PNG compression from `{ level: 9 }` to the default, and invokes `scriptc ... --dynamic` without explicitly pinning Rust. That script is more than ordinary source staging and cannot establish unchanged-source Rust native parity or an equivalent-source performance comparison. The compiler roadmap should remove those compatibility rewrites while keeping resource packaging reproducible.

Evidence: [Redwall refusal](/tmp/scriptc-all-binary-admission-20260913/red-dev__redwall__default/build.json), [retained input inventory](/tmp/scriptc-all-binary-admission-20260913/redwall-existing-inputs.json). Missing paths were rechecked during this audit. The existing vendor binary and old performance comments were not tested or accepted as fresh metrics.

## Responsibility and next actions

1. **Consumer:** align the Bun type directive and provide an authoritative Redwall source/staging/asset contract; make the TOML text boundary accurately typed.
2. **Compiler:** preserve applicable ambient project declarations and lower explicit Bun text/file asset imports.
3. **Compiler:** inspect native npm inference/admission with the existing JS/declaration pairs. No untyped npm dependency replacement is justified by this graph.
4. **Compiler:** implement the already-typed Bun/Node API and reference/union/import cases, with native differential contracts.
5. **Validation:** retry the original entries on the current compiler after targeted work; neither complete red-dev nor Redwall native success is claimed by this read-only audit.
