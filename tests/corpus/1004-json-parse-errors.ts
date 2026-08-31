// JSON.parse syntax errors are CATCHABLE, exactly like Node's SyntaxError.
// The message text itself is unobservable here (the supported catch form is
// bindingless) and its V8-flavored shape is deliberately approximate —
// exact-message assertions live in the runtime C tests (test_json.c), per
// SEMANTICS.md. This program only proves the throw/catch/recover behavior
// matches Node for every syntax-error class.

function attempt(raw: string, label: string): void {
  try {
    const v = JSON.parse(raw) as number;
    console.log("ok", label, v);
  } catch {
    console.log("caught", label);
  }
}

attempt("42", "valid");
attempt("", "empty input");
attempt("   ", "whitespace only");
attempt("{oops", "bad token");
attempt("[1,2,", "unterminated array");
attempt('{"a":1', "unterminated object");
attempt('{"a"}', "missing colon");
attempt('{"a":1,}', "trailing comma");
attempt("[1 2]", "missing comma");
attempt('"unterminated', "unterminated string");
attempt('"bad \\q escape"', "bad escape");
attempt('"\\u123é"', "split utf8 unicode escape");
attempt("01", "leading zero");
attempt("1.", "bare fraction dot");
attempt("1e", "missing exponent");
attempt("-", "lone minus");
attempt("truthy", "bad literal");
attempt("1 2", "trailing content");
attempt("NaN", "NaN is not JSON");
attempt("undefined", "undefined is not JSON");
attempt("'single'", "single quotes");

// Parse failures propagate through call chains to the nearest catch and
// leave earlier work intact.
function parseOrZero(raw: string): number {
  try {
    return JSON.parse(raw) as number;
  } catch {
    return 0;
  }
}
console.log(parseOrZero("5") + parseOrZero("{nope") + parseOrZero("6"));

// finally runs on the exception path of a failing parse.
try {
  try {
    const v = JSON.parse("[") as number[];
    console.log("unreachable", v.length);
  } finally {
    console.log("finally ran");
  }
} catch {
  console.log("caught after finally");
}
