# Live native prototypes in mixed Rust/engine programs

The full Rust corpus on 2026-09-10 found a mismatch in
`2590-object-create-dynamic.js`: after `Object.create(proto)`, adding
`proto.added = "late"` produced `undefined` through the child instead of `late`.
The focused differential reproduced it. Gate D ended with 815 passes and this
failure; its source and dist fingerprints were unchanged throughout the run.

The rest-parameter identity function returns a native dynamic map. The program
also needs the embedded engine, which had disabled all native builtin
specializations. Consequently, `Object.create` marshaled the native prototype
through JSON. The engine retained a copy while later assignments updated the
original native map. This was an identity loss at the representation boundary,
not a missing write or stale property cache.

Rust emission now dispatches this exact builtin by the prototype's runtime
representation. A native map becomes the live prototype of a new native map.
Other representations follow the existing engine call; engine-owned prototypes
retain their handles. The argument is evaluated once. The existing engine-free
implementation is unchanged, and no runtime or consumer source was modified.

The new differential `3164-live-object-prototypes/main.js` covers a native
prototype with an alias, two levels of inheritance, property additions and
updates, assignment shadowing, own-key JSON serialization, and one-time argument
evaluation. An explicitly embedded module supplies an engine-owned prototype to
verify that later engine-side mutations also remain visible. Null-prototype
creation remains covered. Dynamic `delete` is outside this regression's scope:
the frontend reports its existing SC1090 refusal for `any` receivers.

Focused validation passed the original case and the new regression, followed
by five Rust and three LLVM differential cases, with no refusals in the latter.
The mixed-module regression belongs to the Rust lane under the existing harness
policy. ESLint, file-size ceilings, and `git diff --check` passed.

Evidence is retained in `/tmp/scriptc-live-prototype-20260910/`, including the
original emitted Rust, pre-change emitter source, failing and passing test logs.
The complete plain/sanitized gate and the final Redwall measurement are still
required; these focused results are not release approval.
