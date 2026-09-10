# Selecting byte storage before loops

Read-only byte regions previously passed an optional slice to each getter.
The Rust emitter now selects direct slices once before the complete loop.
When any input is a backed view, the other branch retains ordinary getters
for all inputs. Each region emits two alternatives rather than every input
combination. Fresh output slices retain mutable borrowing and checked
indexing; no runtime source change or unsafe access is needed.

`byte-read-regions.test.ts` pins direct selection, multiple inputs, fallback
emission and IR immutability. Corpus 3132 covers direct/backed/mixed inputs,
aliased views, empty loops, once-only index side effects, uninitialized
scalar cells, break/continue and exception unwinding in both paths.

The first corpus run found an independent existing defect: `Buffer.join`
on a backed view indexes empty direct storage and panics. Both the previous
compiler dist and the new source reproduce the same panic at bytes.rs:543.
The original failing source, both executables and stderr are preserved in
the evidence directory. The focused region corpus now observes input
contents using ordinary indexed reads. This does not fix or waive the
backed-join defect; it isolates region validation from that existing issue.

Validation: 12 selected tests pass (seven emission tests and five Rust
corpora: 3127, 3128, 3129, 3131, 3132), with heap audit. Corpus 3132 passes
C and LLVM sanitized. Workspace build, touched-source ESLint, file-line
ceilings and whitespace checks pass. Redwall acceptance passes 38 contracts
and 26 native renderer calls, matching Bun PNG bytes. All 116 analyzed
source hashes match the previous artifact and the current files; runtime
source hashes also match. The full compiler lanes have not passed; this is
not a shipping gate.

Three-sample screening with one warmup, interleaved on CPU 2 under the
resource limiter:

| Candidate | Median ms | Median peak RSS KiB | Binary bytes |
| --- | ---: | ---: | ---: |
| Previous signed-index Rust | 2160.75 | 111316 | 4061968 |
| Rust with loop versions | 1959.01 | 111264 | 4067408 |
| Bun compiled 1.4.1 | 857.34 | 143240 | 81413600 |

Observed 9.3% less median time in this screening; still 2.28 times Bun.
Binary grew by 5440 bytes. All 12 executions match. Host contention and
variance remain material; this is not a confirmed steady gain and must not
be combined with percentages from other rounds.

Evidence: `/tmp/scriptc-byte-loop-versions-20260909/`. Comparison:
`measurements/benchmark.json`, native acceptance: `redwall/acceptance.json`.
The acceptance covers the renderer via its TS adapter, not the full original
Redwall CLI. Consumer source and installed binaries were not modified.

## Seven-sample follow-up

Same artifacts and spec, seven measured rounds plus warmup:

| Candidate | Median ms | Median peak RSS KiB |
| --- | ---: | ---: |
| Previous signed-index Rust | 1742.97 | 111316 |
| Rust with loop versions | 1652.03 | 111084 |
| Bun compiled | 716.12 | 130944 |

All 24 executions match. Median improvement is 5.2%, with a 2.31 times Bun
ratio, but the candidate wins only 3 of 7 same-round comparisons. A slow
candidate sample reaches 2116.17 ms. This weakens the screening result:
performance benefit remains inconclusive under this host's variation.
Keep this as an experimental, correctness-validated optimization, not a
claim of a stable 9.3% speedup. See `measurements-seven/benchmark.json`.
