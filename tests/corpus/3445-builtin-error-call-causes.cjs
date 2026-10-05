// @no-engine
function message() { console.log("message"); return "text"; }
function cause() { console.log("cause"); return 23; }
const error = TypeError(message(), { cause: cause() });
console.log(error.name, error.message, error.cause);
const converted = RangeError({ toString() { console.log("convert"); return "converted"; } }, { cause: cause() });
console.log(converted.name, converted.message, converted.cause);
console.log(Error(7).message, TypeError(null).message, RangeError(false).message);
const empty = SyntaxError(undefined, { cause: 41 });
console.log(empty.name, empty.message === "", empty.cause);
