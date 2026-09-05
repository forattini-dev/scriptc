# scriptc patches over boa_ast 0.22.0

The crate is the registry tarball of boa_ast 0.22.0 with the change below.

## Scope analysis: visit a class method's computed name

`src/scope_analyzer.rs` (all three visitors), `src/function/class.rs`
(`ClassMethodDefinition.name` made `pub(crate)`): field definitions
visited their computed names, method definitions did not. TypeScript's
private-field downlevel emits a method whose computed key assigns
module-level vars to `new WeakMap()`s AND to named function expressions
(`[(_a = new WeakMap(), _f = function _f() { var y; … }, "m")]() {}`,
openai's ChatCompletionStream.mjs); the unanalyzed function bodies
panicked boa's bytecompiler ("binding must exist") for a `var`, or the
`define` opcode for a `let`.

Reproduction (`cargo run --example island_link --features island-eval`):

```js
var _f;
class C { [(_f = function _f() { var y = 1; return y; }, "m")]() { return _f(); } }
export const c = new C().m();
```
