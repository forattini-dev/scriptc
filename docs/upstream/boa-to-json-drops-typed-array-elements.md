# boa: `JsValue::to_json` serializes every typed array as `{}`, dropping its elements

Draft issue text for [boa-dev/boa](https://github.com/boa-dev/boa). **Not filed** —
the maintainer decides whether and when this goes upstream.

- **Component:** `boa_engine::JsValue::to_json`
- **Version:** `boa_engine = "=0.22.0"` (default features)
- **Toolchain:** `rustc 1.98.0 (88d9e12ae 2026-08-18)`, debug profile
- **Platform:** Linux x86_64

---

## Title

`JsValue::to_json` drops typed-array elements (serializes `Uint8Array` as `{}`) and does not honor `toJSON`

## Summary

`JsValue::to_json` returns `Ok(Some({}))` for every typed array, silently losing
the contents. `JSON.stringify` on the same value in V8 (and per ECMA-262
`SerializeJSONObject`, since a typed array's indices are own enumerable
properties) produces `{"0":1,"1":2,"2":3}`.

The failure is silent: no `Err`, no `None`, no panic. A host embedding that moves
binary data out of the realm with `to_json` receives a well-formed empty object
and cannot tell it apart from an object that really was empty.

Two further divergences from `JSON.stringify` show up in the same call and may
share a cause — `to_json` appears not to run any JavaScript during
serialization:

- a `toJSON` method on the value is not called (it is serialized as an ordinary
  property instead);
- accessor properties and `Proxy` traps do not fire.

## Reproduction

`Cargo.toml`:

```toml
[dependencies]
boa_engine = "=0.22.0"
```

`src/main.rs`:

```rust
use boa_engine::{Context, JsValue, Source};

fn probe(context: &mut Context, label: &str, code: &str) {
    println!("--- {label}: {code}");
    let value: JsValue = match context.eval(Source::from_bytes(code)) {
        Ok(v) => v,
        Err(e) => { println!("    eval Err: {e}"); return; }
    };
    match value.to_json(context) {
        Ok(Some(json)) => println!("    Ok(Some): {json}"),
        Ok(None) => println!("    Ok(None)"),
        Err(e) => println!("    Err: {e}"),
    }
}

fn main() {
    let mut context = Context::default();
    probe(&mut context, "typed array", "new Uint8Array([1,2,3])");
    probe(&mut context, "nested in object", "({ b: new Uint8Array([1,2,3]) })");
    probe(&mut context, "nested in array", "[new Uint8Array([1,2,3])]");
    probe(&mut context, "float64 array", "new Float64Array([1.5,2.5])");
    probe(&mut context, "plain object", "({a:1})");
    probe(&mut context, "arraybuffer", "new ArrayBuffer(4)");

    // The same result through the Rust-side constructor, so this is not a
    // property of how the value was created.
    let array =
        boa_engine::object::builtins::JsUint8Array::from_iter(vec![1u8, 2, 3], &mut context)
            .expect("build");
    let value: JsValue = array.into();
    println!("--- rust-side JsUint8Array");
    println!("    {:?}", value.to_json(&mut context));
}
```

## Observed (boa 0.22.0), exit code 0, no panic and no signal

```
--- typed array: new Uint8Array([1,2,3])
    Ok(Some): {}
--- nested in object: ({ b: new Uint8Array([1,2,3]) })
    Ok(Some): {"b":{}}
--- nested in array: [new Uint8Array([1,2,3])]
    Ok(Some): [{}]
--- float64 array: new Float64Array([1.5,2.5])
    Ok(Some): {}
--- plain object: ({a:1})
    Ok(Some): {"a":1}
--- arraybuffer: new ArrayBuffer(4)
    Ok(Some): {}
--- rust-side JsUint8Array
    Ok(Some(Object {}))
```

## Expected (Node v24.15.0 / V8, `JSON.stringify`)

```
uint8:       {"0":1,"1":2,"2":3}
nested:      {"b":{"0":1,"1":2,"2":3}}
inarray:     [{"0":1,"1":2,"2":3}]
float64:     {"0":1.5,"1":2.5}
plain:       {"a":1}
arraybuffer: {}
```

Note that `ArrayBuffer` and `DataView` serialize to `{}` in both — that is
correct, they expose no own enumerable properties. Only typed arrays diverge.
An empty typed array is `{}` in both, so the bug is invisible on the empty case.

### `toJSON` and accessors

```js
const t = new Uint8Array([1, 2]);
t.toJSON = () => "TJ";
JSON.stringify(t)          // Node: "TJ"
```

boa 0.22.0 `to_json` on the same value returns
`{"toJSON":{"length":0,"name":"toJSON"}}` — the method is not invoked, and the
function object is serialized as a property. Separately, a getter
(`{ get b() { throw new Error("x") } }`) and a `Proxy` `ownKeys`/`get` trap were
both observed NOT to run during `to_json`.

## Impact

scriptc embeds boa as the dynamic-evaluation island for compiled binaries and
uses `to_json` to move values from the realm into native code
(`packages/runtime-rust/src/island_eval.rs`, `island_json`). Any `Uint8Array`
crossing that boundary — the common shape for buffers returned by an npm
package — arrives as an empty object. Because `to_json` reports success, the
loss surfaces far from its cause, as a downstream shape error rather than a
serialization failure.

A host that cannot serialize a typed array is workable; a host that reports
success while dropping the data is not. Even returning `Ok(None)` or an `Err`
for typed arrays would be a strict improvement over the current silent `{}`.

## Regression tests on our side

`packages/runtime-rust/src/tests/island_modules.rs` carries `#[ignore]`d tests
asserting the V8 behavior (`island_json_serializes_typed_array_elements`,
`island_json_honors_a_to_json_method`). They are expected to go green once this
is fixed upstream; the ignore attribute names this document.
