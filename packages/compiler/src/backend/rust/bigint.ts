import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

export function emitRustBigIntCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (!expr.fn.startsWith("bigint.")) return null;
  const names: Record<string, string> = {
    "fromString": "from_string", "parse": "from_string", "fromNumber": "from_number", "fromF64": "from_number", "fromBool": "from_bool",
    "toString": "to_string", "toNumber": "to_number", "toF64": "to_number", "inspect": "inspect", "truthy": "truthy", "radix": "to_string_radix",
    "add": "add", "sub": "sub", "mul": "mul", "div": "div", "rem": "rem", "mod": "rem", "pow": "pow",
    "and": "and", "or": "or", "xor": "xor", "shl": "shl", "shr": "shr", "neg": "neg", "not": "not",
    "asIntN": "as_int_n", "asUintN": "as_uint_n",
  };
  const operation = expr.fn.slice("bigint.".length);
  const temps = expr.args.map(() => context.nextTemporary());
  const bindings = expr.args.map((arg, i) => `let ${temps[i]} = ${context.emitExpr(arg)};`).join(" ");
  let result: string;
  if (operation === "cmp") {
    result = `match ${temps[0]}.cmp(&${temps[1]}) { std::cmp::Ordering::Less => -1.0, std::cmp::Ordering::Equal => 0.0, std::cmp::Ordering::Greater => 1.0 }`;
  } else if (operation === "cmpNumber") {
    result = `match runtime::bigint_cmp_number(&${temps[0]}, ${temps[1]}) { Some(std::cmp::Ordering::Less) => -1.0, Some(std::cmp::Ordering::Equal) => 0.0, Some(std::cmp::Ordering::Greater) => 1.0, None => f64::NAN }`;
  } else if (operation === "eq") {
    result = `runtime::bigint_eq(&${temps[0]}, &${temps[1]})`;
  } else if (operation === "eqString") {
    result = `runtime::bigint_eq_string(&${temps[0]}, &${temps[1]})`;
  } else if (operation === "bufferRead") {
    result = `runtime::bigint_buffer_read(&${temps[0]}, ${temps[1]}, ${temps[2]}, ${temps[3]})`;
  } else if (operation === "bufferWrite") {
    result = `runtime::bigint_buffer_write(&${temps[0]}, &${temps[1]}, ${temps[2]}, ${temps[3]}, ${temps[4]})`;
  } else if (operation === "dataViewGet") {
    result = `runtime::bigint_data_view_get(&${temps[0]}, ${temps[1]}, ${temps[2]}, ${temps[3]})`;
  } else if (operation === "dataViewSet") {
    result = `runtime::bigint_data_view_set(&${temps[0]}, ${temps[1]}, &${temps[2]}, ${temps[3]})`;
  } else {
    const name = names[operation];
    if (!name) return context.unsupported(`BigInt operation ${operation}`, expr.loc);
    const args = expr.args.map((arg, i) => ["bigint", "string"].includes(arg.type.kind) ? `&${temps[i]}` : temps[i]);
    result = `runtime::bigint_${name}(${args.join(", ")})`;
  }
  return `{ ${bindings} ${result} }`;
}
