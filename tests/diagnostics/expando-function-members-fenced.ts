// The expando-function form the LOWERING fences: a write to a READ-ONLY
// function member. Members that lower (lower-expando.ts) become module
// globals keyed by (function symbol × member key); `name`, `length`,
// `caller`, `arguments` and `prototype` cannot, because strict-mode JS
// (every module is strict) throws TypeError on the write while a global
// slot would silently succeed — and every later read would then observe a
// value Node never stored.
//
// The neighbouring out-of-scope forms need no fence of ours: the CHECKER
// already refuses an init-position read above the first assignment
// ("used before being assigned"), a runtime-valued member key (the
// implicit-any index), and `delete status.message` ("the operand of a
// 'delete' operator must be optional").

function status(code: number): string {
  return code + "";
}

status.message = "ok";
console.log(status.message, status(404));

status.name = "renamed";
console.log(status.name);
