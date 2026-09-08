# Native TypeScript contract

scriptc's primary mission is to compile well-typed TypeScript through typed
IR to efficient, memory-safe Rust and a native executable. This document
defines consumer obligations and compiler work. It is adoption guidance and
product scope, not a new CLI profile or a claim that all planned support is
implemented today.

The native workflow uses `--backend rust --no-engine`. Existing JavaScript
and npm static admission remain supported where implemented; this contract
does not introduce a blanket ban on JavaScript, `any`, or checked dynamic
values. Embedding an engine with `--dynamic` is a separate compatibility
workflow and does not satisfy native acceptance.

## Consumer requirements

- Use valid TypeScript for application code and keep the project's ordinary
  typecheck passing. Enable `strictNullChecks` (an existing scriptc floor);
  `strict: true` is recommended. Fix actual type/configuration errors rather
  than suppressing them to obtain a binary.
- Describe public boundaries with meaningful types where inference cannot
  recover the contract. Local variables and callbacks do not need redundant
  annotations when their types are already inferable.
- Validate untrusted input and narrow `unknown` before relying on its shape.
  `any`, assertions and declaration files cannot make incompatible runtime
  values safe or supply missing implementations. A supported checked cast
  remains valid; the compiler must preserve its documented checks.
- Select a runtime target (`node24`, `node26`, or `bun`) and APIs implemented
  for that target and backend. Support for a module name does not imply
  support for every overload, option, or behavior in that module.
- Provide statically admissible dependency implementations, including
  transitive dependencies. Type declarations alone are not executable code.
  Replace or isolate an incompatible dependency when choosing the native
  workflow; keep that migration explicit and behaviorally tested.
- Replace runtime source evaluation or open-ended module discovery when it
  requires a JavaScript engine. A finite set of literal imports can be an
  alternative when its signatures are supported. Local literal `import()`
  itself is not excluded from native compilation.

A legitimate migration names the violated rule and preserves the intended
application behavior. Changing a typed parameter to `unknown`, cloning an
object to hide broken aliasing, or deleting assertions from a contract suite
does not repair a compiler defect.

## Compiler obligations

- Infer and specialize from available type and control-flow information.
  Records, unions, optional fields, generics and typed callbacks are compiler
  work when a valid use lacks lowering; their presence is not evidence of
  consumer noncompliance.
- Preserve supported observable behavior, including object identity, shared
  mutation, numeric precision, exceptions and async ordering. Refuse
  unsupported boundaries before producing a misleading native executable.
- Generate efficient Rust: reduce unnecessary allocation, copying, dynamic
  dispatch and reference-count work where semantics permit. Type information
  is an optimization opportunity, not permission to erase runtime behavior.
- Explain failures at source locations. Distinguish consumer requirements,
  missing support and excluded capabilities, with a relevant action. A
  compiler failure is not automatically a request to rewrite the application.
- Publish reproducible correctness and performance evidence. Rust ownership
  does not guarantee bounded memory or better CPU usage; JavaScript sharing
  and cycles still require runtime management. Rustc normally uses LLVM.

## Blocker classification

| Category | Evidence required | Action |
| --- | --- | --- |
| Consumer correction | A documented requirement is violated; for a type error, reproduce it against the ordinary project declarations. | Explain the location, rule and smallest behavior-preserving correction in the consuming repository. |
| Compiler defect or gap | Valid source exposes incorrect behavior, lost type information, missing lowering or a selected native API extension. | Minimize the witness here; implement and add differential regression coverage. Mark planned support separately from implemented support. |
| Outside native scope | The operation needs an explicitly excluded capability, such as runtime JS source evaluation, or a target capability unavailable in the selected workflow. | Describe the boundary and consumer adaptation; an engine build remains a separate option. |

Unknown ownership stays unclassified until reproduced. Do not classify by
diagnostic prefix alone: `SC3003`, for example, can mean either an excluded
engine operation or an unfinished native value boundary. A TypeScript error
introduced by scriptc's dependency/type admission is also compiler work when
the original project passes its normal preflight.

These categories are currently a review/reporting convention. The CLI emits
its existing codes and hints; it does not yet expose this ownership taxonomy.
Each blocker report should retain entrypoint and revisions, target/backend,
source location, actual diagnostic, minimal witness, category and supporting
rule, proposed action, and the validation needed to close it. Diagnostic and
statement totals are not counts of independent defects.

## Adoption workflow

Run from the consuming project, selecting its actual runtime target:

```sh
scriptc coverage src/cli.ts --backend rust --target node24 --no-engine --npm-static auto
scriptc build src/cli.ts --backend rust --target node24 --no-engine --npm-static auto -o ./cli-native
```

Coverage checks admission and backend emission, not successful execution.
Classify failures before assigning work. After a successful build, run the
consumer's relevant contracts against the executable and its Node/Bun oracle,
including output, errors, exit status and filesystem/network effects.

Document consumer migrations separately with before/after behavior and source
identity. Once a workload meets the agreed contract, use the same application
implementation and inputs for native/oracle comparisons. Test adapters may
drive entrypoints; they must not replace application logic to hide gaps.
Full-application acceptance requires the full relevant contract suite;
accepting one entrypoint establishes only that entrypoint's tested behavior.

Consumers are acceptance workloads, not an unlimited promise to implement
Node, Bun or every npm package. Choose compiler work for semantic importance,
reuse across programs and measured cost, alongside named consumer milestones.
The [Rust roadmap](./RUST_ROADMAP.md) tracks priorities and the
[RSP report](./tests/dogfood/rsp-native.md#blocker-ownership) applies this
boundary to current examples.
