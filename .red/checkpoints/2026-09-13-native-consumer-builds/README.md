# Native consumer builds — 2026-09-13

The acceptance target is every original distributed executable from red-skills, redcode and red-dev, with the complete Redcode CLI taking priority. That target is not complete. Consumer sources were preserved; these results do not count replacement launchers or extracted demos as products.

## Latest checkpoint — `5e0830c2`

Compiler `5e0830c24a73a2122b6ecec430c4d31b810de215` implements native Proxy property reads and lazy checked record views, declaration-qualified `Context.Service.use`, and the Symbol and method-receiver behavior needed by the original `serviceUse`. Unsupported operations retain explicit refusals. The complete CLI still does not build.

| Original entry | Latest result | Release bytes | Acceptance |
| --- | --- | ---: | --- |
| Redcode complete CLI | Refused; no executable | — | 3,100 → 3,090 diagnostic occurrences |
| Redcode RPC sidecar | Native Rust; no engine, external FFI or runtime fences | 4,370,568 | 8 original tests, 22 assertions passed |

The CLI comparison removes 13 code/location occurrences and adds three in newly reached lowering paths; six same-code/location message groups also change. There are no remaining diagnostics in `service-use.ts`. The 34-package static selection and release options match the previous attempt except output paths. All 1,323 captured source hashes and the capture sets match; the baseline retains hashes rather than source text. Compiler and consumer sources remained unchanged during the attempt. Counts include cascades and instantiations, so they are not independent bugs or completion percentages.

The original `serviceUse` also executes with the original filesystem method types and Effect fixtures: Node, Bun, native Rust and native Rust with heap audit produce identical output and empty stderr. This validates the helper and reference semantics, not the complete filesystem service or CLI. The latest sidecar release is 11,024 bytes larger than the preceding release (+0.253%; 4.168 MiB total), and its exact ELF passed the unchanged protocol tests. No new application CPU, RAM or execution-time comparison was performed.

Focused validation passed across 45 distinct differential programs, including three existing dynamic-engine programs; the seven new programs are explicitly engine-free. The Rust runtime passed 254 tests and Clippy with warnings denied. All 121 diagnostic programs passed in a clean final rerun, and compiler build, lint and source ceilings passed. `proxy-validation.json` records this slice; `validation.json` remains the historical keyed-reference slice. The full branch plain and sanitized shipping gate remains pending. This checkpoint does not assert release, main integration or push.

`latest-builds.json` records the latest attempts. `latest-builds-24d0179f.json` preserves the preceding rebuilds, and `admission.json` preserves the earlier all-entry baseline. The other 16 original entries were not rerun at `5e0830c2`; the inventory still contains 13 red-skills, three redcode and two red-dev entries, with one original entry proven native so far under the recorded attempts.

## Historical original-entry admission baseline

Compiler f1087c892c9fb38ad41c712417284be98dadfe7d. The inventory deduplicates aliases/platform variants into 18 distributed source entries. Seventeen entries received a default dev-mode attempt; full Redcode has its separate release-mode attempt with an explicit 34-package static selection. Three additional AUTO attempts repeat existing entries.

Default npm admission is OFF. The 58-second default/AUTO timeout at one CPU and a 3 GiB memory limit makes a timeout inconclusive, and an OFF refusal does not establish maximum compiler capability. Diagnostics are occurrences with cascades, not independent bugs or a completion percentage.

| Original source | Default OFF | AUTO |
|---|---|---|
| red-skills/dev | Refused (1 occurrences) | Timeout; inconclusive |
| red-skills/castle-mcp | Refused (234 occurrences) | Not attempted |
| red-skills/code-nav | Refused (22 occurrences) | Not attempted |
| red-skills/memory | Refused (56 occurrences) | Not attempted |
| red-skills/memory-mcp | Refused (649 occurrences) | Not attempted |
| red-skills/brain | Refused (89 occurrences) | Not attempted |
| red-skills/brain-mcp | Refused (37 occurrences) | Not attempted |
| red-skills/rsp | Refused (331 occurrences) | Not attempted |
| red-skills/redskilled | Refused (53 occurrences) | Not attempted |
| red-skills/herdr | Refused (2 occurrences) | Not attempted |
| red-skills/benchmark-memory | Refused (245 occurrences) | Not attempted |
| red-skills/benchmark-code-understanding | Refused (17 occurrences) | Not attempted |
| red-skills/opencode-host | Refused (23 occurrences) | Not attempted |
| redcode/lildax | Timeout; inconclusive | Timeout; inconclusive |
| redcode/rpc-sidecar | Native Rust executable | Not attempted |
| red-dev/red-dev | Refused (773 occurrences) | Refused (773 occurrences) |
| red-dev/redwall | Refused (3 occurrences) | Not attempted |

The complete Redcode CLI was refused with 3,100 occurrences in the separate 34-package baseline. No full Redcode native executable was produced.

## Historical original RPC sidecar acceptance

The original packages/rpc-sidecar/src/cli.ts builds with the Rust backend, engine none, no external FFI and no runtime fences. Both development and release ELFs passed the unchanged package integration suite through REDCODE_RPC_SIDECAR_COMMAND: 8 tests, 22 assertions, zero failures. This validates the sidecar protocol; the separate real-server test hardcodes Bun and was not counted as native coverage.

| Optimization | Bytes | Original integration tests |
|---|---:|---:|
| Development | 65,317,408 | 8/8 |
| Release | 4,358,904 | 8/8 |

The size difference is dev versus release configuration, not a new optimizer performance result. No application CPU, RAM or execution-time comparison was performed in this checkpoint.

## Boundaries and ownership

- Redwall needs its normal generated input layout: three relative generated imports and .red/tmp/redwall-build/src are absent in the current consumer snapshot. This is a generation prerequisite, not evidence that a previously generated Redwall graph regressed.
- The js-yaml declaration resolution failure in red-skills/dev requires further ownership diagnosis; it is not established consumer fault.
- Four benchmark-memory diagnostics come from a TypeScript checker panic in tuple serialization. An isolated query investigation is retained under /tmp/scriptc-checker-tuple-panic-20260913; no speculative checker recovery was integrated.
- Generic/dependency lowering, unsupported Proxy operations, and further Node/Bun runtime APIs remain compiler work. Source typing or packaging changes in consumers must be identified separately and cannot substitute for those compiler features.

## Historical compiler continuation — `24d0179f`

Compiler checkpoint `24d0179f66aa154c10eb61cd73bcee6862349b9b` implements heterogeneous service method lookup, byte and BigInt fields in shared records, and flat-array/byte results widened to Effect<unknown>. Corpus 3238–3243 covers the actual filesystem parameter shapes, function identity/replacement, width-preserved properties, evaluation order, and reference mutations under Node/Bun. This does not claim native Proxy support, arbitrary Effect composite erasure, direct Record<string, Uint8Array> or Record<string, bigint> admission, or default Object.prototype reflection.

Focused validation passed: 35 distinct native differential programs and all 121 diagnostic programs; native record, backend admission, projection refusal and native prototype-refusal contracts also passed. The adjacent validation.json retains the program names and log locations.

The full branch plain and sanitized shipping gate remains pending. This checkpoint is local work and does not assert release or main integration.

## Historical original Redcode rebuilds — `24d0179f`

Both the complete CLI and the original RPC sidecar were retried against `24d0179f`. The adjacent `latest-builds-24d0179f.json` records these terminal outcomes and evidence digests; `admission.json` remains the earlier all-entry baseline. The other original entries were not rerun at that checkpoint.

| Original entry | Result at `24d0179f` | Release bytes | Acceptance |
| --- | --- | ---: | --- |
| Redcode complete CLI | Refused; no executable | — | 3,100 diagnostic occurrences |
| Redcode RPC sidecar | Native Rust; no engine or external FFI | 4,359,544 | 8 original tests, 22 assertions passed |

The full CLI used the same explicit 34-package selection and release options except output paths. Its 3,100 code/location diagnostic occurrences did not change; nine same-code/location message groups did. All 1,323 common captured source-text hashes match, while 51 Undici files were no longer captured; all 51 were separately verified unchanged on disk. The tracked consumer snapshot matches the previous attempt and stayed unchanged during both builds. The source capture sets are not identical. Attempt duration is not executable performance.

The sidecar release at `24d0179f` is 640 bytes larger than its preceding release (+0.0147%). Its original integration suite executed the exact ELF through `REDCODE_RPC_SIDECAR_COMMAND`; compiler and consumer sources remained unchanged through acceptance. No runtime CPU, RAM, or speed comparison was performed. The large historical development binary and this release binary use different optimization settings.

## Next compiler work

The former `serviceUse` Proxy and mapped-record conversion blockers are resolved in the real CLI graph. Newly reached diagnostics identify unsupported `locations.get` lowering, object spread after explicit properties, and `unknown` passed where a typed array of service records is expected. These need minimization and compiler-versus-consumer ownership diagnosis before choosing the next acceptance slice.

A separate reproduced compiler bug remains in callback covariance from `() => Promise<T>` to `() => Promise<unknown>`: the adapter can discard the original Promise and throw during conversion. Proxy thenable assimilation is explicitly refused across seven resolution routes; that refusal is not an implementation of assimilation. Proxy reflection, mutation, copying and general Symbol-keyed storage, plus `this` across suspension, remain outside this implemented subset. Nested records/arrays through Effect erasure and further dependency/runtime gaps also remain.

After the next coherent compiler fix, rerun the complete original CLI and refresh the original-entry matrix with suitable dependency admission and time limits. Complete the plain and sanitized branch gate before shipping.

## Evidence

The adjacent admission.json preserves the compact result matrix, options, source commits and release artifact hash. Full commands, source hashes and logs are retained in:

- /tmp/scriptc-all-binary-admission-20260913
- /tmp/scriptc-redcode-sidecar-release-20260913
- /tmp/scriptc-redcode-rpc-native-acceptance-20260913
- /tmp/scriptc-redcode-rpc-release-acceptance-20260913
- /tmp/scriptc-keyed-reference-semantics-20260913
- /tmp/scriptc-keyed-related-final-20260913.log
- /tmp/scriptc-redcode-keyed-methods-20260913a
- /tmp/scriptc-redcode-sidecar-keyed-release-20260913
- /tmp/scriptc-native-proxy-20260913
- /tmp/scriptc-native-proxy-original-20260913/full-types-final
- /tmp/scriptc-redcode-native-proxy-20260913a
- /tmp/scriptc-redcode-sidecar-proxy-release-20260913
- /tmp/scriptc-proxy-promise-debug-20260913
