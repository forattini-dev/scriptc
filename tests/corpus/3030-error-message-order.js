let events = "";
function message() {
  events += "message;";
  return { toString() { events += "convert;"; return "text"; } };
}
function cause() { events += "cause;"; return "reason"; }
// @ts-ignore JavaScript Error accepts non-string messages.
const error = new Error(message(), { cause: cause() });
console.log(error.message, error.cause, events);

events = "";
try {
  // @ts-ignore JavaScript Error accepts non-string messages.
  new TypeError({ toString() { events += "throw;"; throw new Error("inner"); } }, { cause: cause() });
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message, events);
}
events = "";
function symbolMessage() { events += "symbol;"; return Symbol("message"); }
try {
  // @ts-ignore Symbol messages must throw, after argument evaluation.
  new Error(symbolMessage(), { cause: cause() });
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message, events);
}
