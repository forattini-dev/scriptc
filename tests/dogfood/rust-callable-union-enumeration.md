# Native callable unions and JSON record keys

The Rust corpus refused `2850-namespace-object-value/main.ts` at
`Object.values(Event)`. Its frontend IR correctly represented the resulting
union as `number[] | ((string) => string) | string`. Rust's shared-record
enumeration tried to recover that union from dynamic storage through JSON,
which cannot carry its function arm.

`native-union-check.ts` now selects disjoint runtime variants directly and
delegates each selected arm to its existing native checked conversion. Arrays
and closures keep their original identity. The planner refuses overlapping
outer tags rather than selecting the first array, record or callable signature.
JSON-compatible unions and existing discriminated-record paths retain their
previous conversion path. The change adds no unsafe code.

Corpus 3141 exercises values/entries containing arrays, functions and scalars,
calls the recovered functions, mutates a recovered array and checks identity.
Two unit tests reject ambiguous tags and unclassified dynamic arms.

The adjacent 3072/3073 controls exposed another build error: JSON record
decoders called `.as_str()` on a `JsString`, reaching unstable `str_as_str`.
The retained compiler build reproduced it and generated a byte-identical
3072 Rust source before the union fix. Named keys now compare through
`JsString` equality and UTF-16-aware literals. Overflow insertion also uses
exact string equality, preserving distinct lone surrogates and U+FFFD.
Corpus 3142 verifies decoding, serialization and key enumeration.

## Validation and limits

- Five Rust differential programs passed: 2850 namespace, 3072, 3073, 3141,
  and 3142. Both planner tests passed.
- Existing 2850 namespace and 3072 controls also passed C and LLVM sanitized.
- Workspace build, ESLint with zero errors, whitespace and file ceilings passed.
- New corpus cases are Rust-only: C/LLVM explicitly refuse 3141's shared
  callable-record exit; both collapse 3142's distinct surrogate keys into
  U+FFFD. Their failing runs are retained, not counted as parity successes.

Evidence: `/tmp/scriptc-namespace-union-20260909/`, including the baseline IR,
original sources, pre-fix failures, generated-source hashes and test logs.
The full plain/sanitized gate remains pending. No new Redwall performance
claim is attached to these corrections.
