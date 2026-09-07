class OptionalError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "OptionalError";
  }
}

let calls = 0;
function message(present: boolean): string | undefined {
  calls++;
  return present ? "optional" : undefined;
}

console.log(new OptionalError().message, String(new OptionalError()));
console.log(new OptionalError(message(true)).message, calls);
console.log(new OptionalError(message(false)).message, calls);
console.log(new TypeError(message(true)).message, calls);
console.log(new RangeError(message(false)).message, calls);
const cause = new Error(message(false), { cause: "reason" });
console.log(cause.message, cause.cause, calls);
