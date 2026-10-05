# Checkpoint: callable builtin Error constructors

The frontend now lowers direct calls to its existing Error, TypeError, RangeError and SyntaxError builtins without `new`. It resolves standard-library declaration identity, not the callee's spelling. Calls and construction share one extracted argument-lowering helper, with the existing inline-cause boundary and message/cause evaluation order. DOMException and user classes are not admitted by this path. This implements the callable-constructor rule in the [ECMAScript specification](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-nativeerror), not a Baldim-specific replacement.

## Additional generic corrections

JavaScript overload resolution can produce `TypeError & Error` for a builtin call. The type mapper now preserves the most specific builtin Error layout only when every mapped constituent belongs to the same builtin ancestor chain. User classes, additional record refinements, unmapped constituents and sibling builtin classes are not erased. The helper has co-located white-box tests.

Native Rust errors now compare by their existing reference identity, using `Rc::ptr_eq`, instead of equal name/message/code/cause fields. Two runtime tests failed before this correction and pass afterwards, covering aliases, independent matching errors, matching causes, property mutation and cloned DOMException values. No unsafe code or new FFI was introduced.

The initial regression also exposed missing `ArrayElement` support for directly stored native Error objects. The callable-constructor corpus was reduced to ordinary function arguments to isolate this step. Error arrays remain an investigation item; no support claim or refusal was invented for them.

## Evidence

Corpus programs 3444–3446 cover all four currently implemented callable Error builtins, default and undefined messages, fresh identity, instanceof, catch behavior, inline cause, primitive and custom ToString conversion, argument order and local function shadowing. Package integration tests compare stdout, stderr, status and signals against Node; native Rust runs use heap audit and require no engine, external FFI or runtime fences.

The final nineteen-test integration battery passes with explicit Node 26 and Node 24 targets and their respective local oracles. It includes Rust dev/release, C and LLVM native executions, four unchanged new-Error regression programs, and three refusal controls. Five intersection unit tests and twenty source-stack regression tests also pass. The two Node compatibility CI invocations now include the new integration file.

The unchanged original error-call diagnostic fixture also builds as a native Rust binary and matches Node's `TypeError kind` and `RangeError range` output, with empty stderr and exit zero. The original atomic-sleep implementation, admitted through the existing explicit diagnostic opt-in, now has three failed statements instead of seven: the two branch-local `module.exports` assignments and the unresolved imported sleep binding remain. Its fresh report is `.red/tmp/zlib-postfix-20261004-2lOGxK/atomic-after-error-call-final/probe.json`. This is not automatic npm admission or a working original atomic-sleep binary.

## Original consumers

The final unchanged Baldim entry was rebuilt for Node 26, stable Rust and no engine. It still refuses with four SC2013 diagnostics involving Pino/Recker and one SC2011 diagnostic. Fresh evidence is `.red/tmp/zlib-postfix-20261004-2lOGxK/baldim-final-node26/probe.json`; it took 88,442 ms and peaked at 652,540 KiB RSS. No package was replaced, no import was silently removed, and no S3 request was made.

The final compiler/runtime also rebuilt the original redwall PNG codec again. Reports `redwall-png-final-node26/probe.json`, `png-final-differential-26.10.0.json` and `png-final-differential-24.15.0.json` in the same scratch directory confirm no-engine Rust execution and byte-identical complete output files for all six original wallpapers against both local Nodes. This remains codec validation, not a full redwall build. The full red-dev and redskilled consumer dependency-installation barriers are unchanged.

## Gate posture

Workspace build, Clippy with warnings denied for the runtime, manifest drift check, Node compatibility drift check and git diff whitespace check pass. Focused ESLint reports zero errors; existing warnings are not hidden. Both full plain and sanitized lanes were retried after the implementation and stopped at the existing sandbox EPERM execution boundary in native-toolchain.test.ts:228, after four passing tests. The full runtime suite, now containing 278 tests, was also retried serially and fails in network tests before exiting abnormally at a UDP test. None of these full gates is claimed green. The file-size ratchet still reports 33 WIP violations; no frozen ceiling was increased.

The six focused C/LLVM differential cases also pass with explicit Node 26 target and sanitizer enabled. This local run used `ASAN_OPTIONS=detect_leaks=0` because of the sandbox's LeakSanitizer restriction; it is not proof of LeakSanitizer cleanliness or a substitute for the full sanitized gate.

Local oracles are Node 26.10.0 and Node 24.15.0. The former is not the project's exact Node 26.8.1 pin. All Rust development here used stable 1.98.0, not nightly.

## Next coherent frontend step

Conditional CommonJS exports require an export-value cell updated at the actual executed assignment, plus lexical-symbol-aware collection of branch-local functions. The compiler must preserve distinct same-named functions in different branches, require-cache behavior, argument/body effects and default-import snapshots. Merely accepting nested export assignments or aliasing the last source occurrence would miscompile the original atomic-sleep branches. After that family has differential coverage, retry automatic package admission and the unchanged original Baldim entry; Recker's DNS-promises boundary and the aggregate unknown-value error remain independent work.

The maintainer approved local development without fetch/reconcile for this phase. Existing WIP is preserved; no commit or push was performed. The application-compilation objective remains incomplete.
