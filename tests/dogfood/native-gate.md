# Native repository gate follow-up

Consumer acceptance and repository validation are separate. RPC sidecar and
Redwall acceptance do not make the full repository gate green. The Effect
milestone remains in progress; RSP/Brain and full red-dev/redcode acceptance
remain unfinished.

The local fallback began on the clean, immutable Redwall snapshot
`e7bcadbc6c8b7e7166a380fb81269b713fb295bf`. Sandbox configuration was unavailable
(`SCRIPTC_SANDBOX_IMAGE` absent). The plain lane is still running with observed
failures, and the sanitized lane is pending. Its supervisor was recovered
after the original tool session disappeared; the test process itself survived.
The run uses a two-core CPU quota, two Vitest workers, one compiler worker per test
worker, and a private persistent cache. It cannot validate later Effect or
runtime repairs. A fresh immutable gate must cover the final changes before
shipping.

Current local run evidence is in `/tmp/scriptc-redwall-full-gate.json`,
`/tmp/scriptc-redwall-full-plain.log` and, once started,
`/tmp/scriptc-redwall-full-sanitized.log`. These are workstation artifacts,
not portable checked-in proof of a passing gate.

| Finding | Evidence and disposition |
| --- | --- |
| Library refusal and sanitizer fixtures | Repaired in `ace7948f`; 16 selected library-mode cases and four callback cases passed. |
| Windows clocks and sleeps | Cross compilation reproduced missing `clock_gettime`, `CLOCK_MONOTONIC`, `CLOCK_REALTIME` and `nanosleep`. Runtime-owned Win32/POSIX helpers now pass the Windows PE/network/TLS/dynamic/fetch cross-build and the Windows/Linux ARM regex cross-build. Twelve selected C/LLVM differential cases pass in each local lane (plain and sanitized). Windows execution was not run on this Linux host. |
| Windows certificate-store fixture | The EKU-only probe did not reference store enumeration, so the linker removed the `TrustedPeople` string asserted by the test. The probe now includes an enumeration path, and its cross-build assertions pass. |
| Fetch test proxy contamination | `fetch.test.ts` poisons the compiler process's proxy variables, which Cargo inherits while downloading rusty_v8. The archive returned HTTP 200 with the normal environment; the refused proxy reproduced connection failure. Isolating the proxy to executed fixtures is pending. |
| Surface, Date-fence and coverage expectations | Existing expectations disagree with the current manifest/lowering. Each witness must be checked before updating expectations. |
| Deferred catch-binding class failures | Two JS class-deferral cases fail compilation with constructor-assigned fields shadowing methods. Unresolved. |
| Static executable size | The hello-world size assertion observed 463,720 bytes against a 392,000-byte limit. Cause and acceptable budget remain unresolved. |
| Cache identity and timing cases | Several mutation/publication/LRU cases failed; distinguish actual cache defects from timing failures before changing tests. |
| Whole-corpus coverage sweep | The single sweep exceeded its 600-second timeout. This is not evidence that every individual coverage case failed. |

Use the resource limiter for focused checks. Native tests need a private
0700 cache, and inherited `LD_LIBRARY_PATH` disables persistent cache reuse.
Do not disable sanitizers or relax behavioral assertions to make a gate pass.
