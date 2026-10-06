# Class templates, slice 1

Date: 2026-10-06. Branch: `dogfood/class-templates`. Scope: Rust backend, `allowEngine: false`.

The decision brief referenced by the mission (`2026-10-05-class-factory-decision-brief.md`) is not present in this checkout or anywhere on disk; this note is derived from the mission statement, the 2026-10-03 checkpoints, and the code.

## Confirmed against the code

- A class expression inside any function-like body is fenced in `lowerClassExpressionInfo` ("class expressions inside functions"), and `classExprNeverRegisters` keeps its instance and static types unmapped.
- `extends <expr>` reaches the "extending computed expressions" fence unless the expression is an identifier, a property-assigned class, a class expression, or a recognised mixin/closed-factory call (`lower-mixins.ts`, `class-factory-shapes.ts`).
- The existing factory path specialises one immortal class per once-evaluated top-level call site, with captures in module globals. It cannot express two evaluations from one call position.
- `classval` is a `usize` preorder in the Rust backend (`values.ts`, `expressions.ts` `classRef`/`newValue`/`instanceOfValue`); it carries no per-evaluation identity or environment.
- The Rust runtime collects cycles (`heap.rs` trace/clear-edges), so an evaluation object referenced from its own instances is reclaimed.
- The frontend already carries backend-specific lowering flags (`native*` options in `index.ts`), but templates need none: they use only existing IR.

## Representation chosen

A template is lowered entirely in the frontend onto existing IR constructs. There is no new IR node and no validator change; C and LLVM backend sources are untouched. Templates are not gated by backend because they are ordinary IR, but only the Rust backend was differential-tested in this slice.

- The class expression `E` inside function `F` is collected ONCE as an ordinary IR class `T` (one static shape: fields, vtable methods, base chain). `T` gets one hidden instance field `%template` of type `object:T%class`.
- `T%class` is a synthetic standalone IR class. One instance is allocated per evaluation of `E`; that object IS the class value. It holds a snapshot of every binding of `F` (or enclosing functions) that `E`'s members read.
- Identity: `===` on two class values is object pointer identity, so `f() !== f()`.
- `.name`: the NamedEvaluation name of `E` is a compile-time constant per template and folds to a string.
- `new X(args)`: `new T(X, args)`. `T`'s constructor takes the evaluation as a hidden first parameter and stores it in `%template` before `super()` and before field initializers, so no user code can observe the slot unset.
- Instance and constructor bodies read captures through prologue locals bound to the captured symbols and initialised from `this.%template`; nested arrows capture those locals through the ordinary machinery.
- Static methods become `%T.static:m(env, args)`; their captures read from the hidden `env` parameter. `this`/`super` in static members stay fenced (existing rule).
- `v instanceof X`: the preorder test against `T` and `v.%template === X`.
- Self reference (`let Ref; return (Ref = class …)`): reads of `Ref` inside members are the evaluation object itself.

## Extends through an expression (exact class flow)

`class D extends <expr>` is admitted when the checker's type of `<expr>` is a class static side whose declaration is a template class expression `E` (one construct signature, no union, not any), and the expression lowers to exactly `object:T%class` without a dyn conversion at the heritage. The proof is the IR's nominal typing: only an evaluation of `E` can produce a `T%class` value, because `T%class` has no user-visible constructor. `D`'s IR base is `T`; a module global `%g.<D>.%base` stores the heritage value at `D`'s statement (Node's evaluation point and TDZ), `D`'s constructor passes it as the hidden argument of `T`'s constructor, and static calls through `D` devirtualise to `T`'s statics with that environment.

## Soundness conditions for the snapshot

A captured binding is admitted only if it cannot change after the evaluation: a `const`; a parameter, `let` or `var` with no write anywhere; or the self-assignment pattern above. It must be declared before `E` in source order. Anything else is a named refusal.

## Deliberately refused in this slice (named SC1090)

- Template static fields and static blocks; private `#names`; computed member keys; decorators; generic class expressions.
- A template whose base is not a static program class (a template-of-template, a parameter base, builtin bases such as `Uint8Array`).
- Writes to captured bindings, or captures declared after the class expression.
- A heritage expression whose type is a union of classes, `any`/dyn, or whose lowering is not exactly the template's class object.
- `D extends <template value>` where `D` itself is inside a function (a template over a template).
- Flowing a template class value into a `typeof C` classval slot, `X.prototype`, and `C`/`LLVM` backends.

The existing top-level specialisation (`class-factory-*`, `lower-mixins.ts`) keeps precedence for its admitted call sites; only positions it refuses (calls inside functions) fall through to templates. Mixins over a parameter base keep their own path.

## As implemented

- `packages/compiler/src/frontend/lowering/class-templates.ts` holds the whole mechanism; the integration points are `lowerClassExpressionInfo`/`lowerClassExpression`, the constructor, method and static-method lowering, `superCallStmt`, `lowerNew`, the static-call and class-value-property paths (`lower-classes.ts`), `instanceof` and the self-assignment in `lower-exprs.ts`, the class-static type mapping hook (`type-mapper.ts`), and the heritage evaluation at the class statement (`lower-module-init.ts`).
- The type mapper collects a template on demand. A refused collection reports its diagnostics to the declaration that needed the type; builder-method class nodes probe silently so the per-site specialization keeps its own fences.
- The closed-factory specialization (`class-factory-*`) now applies only when every reference to the factory is a pinned top-level call (`everyFactoryReferencePinned` in `lower-mixins.ts`); otherwise the factory is an ordinary function returning a template. Builder methods whose class is an admitted template are collected as ordinary methods.
- `class D extends <expr>` admits a template evaluation when the checker's type of the expression is a single class static side declared by a template node and the lowered value is exactly that template's evaluation class. Unions, `any`, refused templates, and derived classes that are not top-level declarations keep named refusals.
- Rust backend: reading an immutable object-typed module global in its temporal dead zone now throws Node's `ReferenceError: Cannot access 'X' before initialization` instead of panicking (`values.ts`), which the heritage TDZ case needs.
- Known gap left untouched: `new C(arguments[0])` inside a function that reads `arguments` produces Rust that does not compile (pre-existing, reproduced without templates).
