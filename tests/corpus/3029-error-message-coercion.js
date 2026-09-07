class CoercedError extends Error {
  /** @param {unknown} value */
  constructor(value) {
    // @ts-ignore JavaScript Error applies ToString to non-undefined messages.
    super(value);
    this.name = "CoercedError";
  }
}

/** @param {unknown} value */
function show(value) {
  const error = new CoercedError(value);
  console.log(error.name, error.message);
}

show(undefined);
show(null);
show(42);
show(-0);
show(NaN);
show(Infinity);
show(false);
show("");
show("text");
show([1, null, "end"]);
show({ value: 3 });
let calls = 0;
function effect() { calls++; return "evaluated"; }
show(effect());
console.log("calls", calls);
show({ toString() { calls++; return "custom"; } });
console.log("calls", calls);
show({ toString: 3, valueOf() { calls++; return 17; } });
console.log("calls", calls);
try {
  show({ toString() { throw new Error("conversion failed"); } });
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
try {
  show({ toString: 3, valueOf: 4 });
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
