export var ParseError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ParseError";
  }
};
export var InvalidError = class extends ParseError {
  constructor(value) {
    super("invalid", "INVALID", { value });
    this.value = value;
    this.name = "InvalidError";
  }
};
