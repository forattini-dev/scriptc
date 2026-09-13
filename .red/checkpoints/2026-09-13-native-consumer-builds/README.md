# Native consumer builds — 2026-09-13

The acceptance target is every original distributed executable from red-skills, redcode and red-dev, with the complete Redcode CLI taking priority. That target is not complete. Consumer sources were preserved; these results do not count replacement launchers or extracted demos as products.

## Original-entry admission baseline

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

## Validated original RPC sidecar

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
- Generic/dependency lowering, native Proxy, and further Node/Bun runtime APIs remain compiler work. Source typing or packaging changes in consumers must be identified separately and cannot substitute for those compiler features.

## Compiler continuation

Compiler checkpoint `24d0179f66aa154c10eb61cd73bcee6862349b9b` implements heterogeneous service method lookup, byte and BigInt fields in shared records, and flat-array/byte results widened to Effect<unknown>. Corpus 3238–3243 covers the actual filesystem parameter shapes, function identity/replacement, width-preserved properties, evaluation order, and reference mutations under Node/Bun. This does not claim native Proxy support, arbitrary Effect composite erasure, direct Record<string, Uint8Array> or Record<string, bigint> admission, or default Object.prototype reflection.

Focused validation passed: 35 distinct native differential programs and all 121 diagnostic programs; native record, backend admission, projection refusal and native prototype-refusal contracts also passed. The adjacent validation.json retains the program names and log locations.

The full branch plain and sanitized shipping gate remains pending. This checkpoint is local work and does not assert release or main integration.

## Latest original Redcode rebuilds

Both the complete CLI and the original RPC sidecar were retried against `24d0179f`. The adjacent `latest-builds.json` records these terminal outcomes and evidence digests; `admission.json` remains the earlier all-entry baseline. The other original entries were not rerun at this latest checkpoint.

| Original entry | Result at `24d0179f` | Release bytes | Acceptance |
| --- | --- | ---: | --- |
| Redcode complete CLI | Refused; no executable | — | 3,100 diagnostic occurrences |
| Redcode RPC sidecar | Native Rust; no engine or external FFI | 4,359,544 | 8 original tests, 22 assertions passed |

The full CLI used the same explicit 34-package selection and release options except output paths. Its 3,100 code/location diagnostic occurrences did not change; nine same-code/location message groups did. All 1,323 common captured source-text hashes match, while 51 Undici files were no longer captured; all 51 were separately verified unchanged on disk. The tracked consumer snapshot matches the previous attempt and stayed unchanged during both builds. The source capture sets are not identical. Attempt duration is not executable performance.

The latest sidecar release is 640 bytes larger than the previous release (+0.0147%). Its original integration suite executed the exact ELF through `REDCODE_RPC_SIDECAR_COMMAND`; compiler and consumer sources remained unchanged through acceptance. No runtime CPU, RAM, or speed comparison was performed. The large historical development binary and this release binary use different optimization settings.

## Next compiler acceptance slice

The complete CLI's `ServiceUse` still has two direct blockers: `new Proxy` and the final `as ServiceUse` conversion. The cast diagnostic already contains the expected mapped method signatures, so this is not a missing implementation of mapped types from scratch. The native representation and its conversion need to preserve the object's behavior:

1. Add a native Proxy reference with its own identity and traced target/handler ownership.
2. Implement property reads with the correct key and receiver, including symbols, live handler changes, and fallback when the get trap is absent. Handle incompatible descriptor invariants and other operations explicitly.
3. Expose the typed view lazily; do not enumerate or validate all fields during the cast, populate the accessor cache prematurely, or execute Effects during property access.
4. Validate by importing the original `serviceUse`, covering cached accessor identity, deferred/repeated execution, missing methods, service replacement and the real filesystem signatures, then retry the complete CLI and the original-entry matrix.

Nested records/arrays through Effect erasure and other dependency/runtime gaps remain separate work. Passing this slice alone will not establish that the full CLI compiles.

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
