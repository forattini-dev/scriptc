# Redwall: current Rust and compiled Bun, 2026-09-10

Both executables were rebuilt from the same current TypeScript entry and
117 analyzed source/configuration files, checked by SHA256 before and after.
Rust uses no JavaScript engine or external FFI and reports no runtime fences.
Each executable passed the same 38 consumer contracts, including 26 PNG
renders compared byte-for-byte against the original Bun renderer.

Median of 11 paired rounds after one warmup per candidate. Each sample is a
fresh process; candidate order alternates. The supplied 4K workload includes
startup, input/output and rendering. Both run on CPU 2 under a one-CPU quota.
No compiler processes were active at the start; this is a shared workstation,
not an idle dedicated benchmark host. Elapsed ranges: Rust 551.47–679.02 ms,
Bun 607.09–738.31 ms.

| Executable | Elapsed ms | CPU seconds | Peak RSS MiB | Executable MiB | Executable bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| rust-final | 586.64 | 0.58 | 76.96 | 3.88 | 4072624 |
| bun | 639.25 | 0.63 | 135.00 | 77.64 | 81413600 |

Rust used 8.23% less elapsed time, 7.94% less CPU time, 42.99% less peak RAM,
and a 95.00% smaller executable. It won 10 of 11 time pairs. All 24 samples,
including warmups, produced identical output. The reported sixfold slowdown
is absent from this current build and workload. These measurements do not
establish universal backend superiority or promise this ratio on other inputs.

The full plain and sanitized repository gates are still pending. This is
current performance/consumer acceptance evidence, not release approval.
The earlier 591.40 ms vs 667.24 ms checkpoint remains a separate experiment;
do not attribute the difference between rounds to a new optimization here.

Evidence: acceptance.json and contract.stderr under redwall/; compiled Bun
identity and contracts in bun-provenance.json and bun-contract.log; paired
samples in measurements-bun/benchmark.json; source identity confirmation and
scope in measurement-validation.json. All paths are relative to this report.

## Original workload audit

`original-workload-audit.json` verifies that the current measurement preserves
exactly the original 6.61x-slowdown benchmark's artwork and font bytes, theme,
state and calendar values. The input JSON differs in formatting and file
locations only. The renderer and theme source files still match their original
recorded hashes. The resulting PNG is also identical to the original: 3840x2160,
108881 bytes, SHA256 4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6.
The comparison has not substituted an easier input for the reported workload.
