// Bundlers emit class declarations as var-bound class expressions.
var ParseError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ParseError";
  }
};
var MissingRequiredError = class extends ParseError {
  constructor(optionName) {
    super(`Missing required option: --${optionName}`, "MISSING_REQUIRED", { option: optionName });
    this.optionName = optionName;
    this.name = "MissingRequiredError";
  }
};
let SpecificError = class extends MissingRequiredError {
  constructor(optionName) {
    super(optionName);
    this.name = "SpecificError";
  }
};
const error = new SpecificError("output");
console.log(error.name, error.message, error.code, error.optionName);
console.log(JSON.stringify(error.details));
console.log(error instanceof Error, error instanceof ParseError);
console.log(error instanceof MissingRequiredError, error instanceof SpecificError);
try { throw new MissingRequiredError("input"); } catch (caught) {
  if (caught instanceof Error) console.log(caught.name, caught.message);
}

// Exact receivers also control writes to a class's own static storage.
var Counter = class {
  static count = 1;
  value() { return "base"; }
};
let Child = class extends Counter {
  static label = "before";
  value() { return "child"; }
};
Counter.count = 2;
Child.label = "after";
console.log(Counter.count, Child.label, new Child().value());
