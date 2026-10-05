// @no-engine
class StorageError extends Error {
  constructor() {
    super("missing");
    this.statusCode = 500;
    this.retriable = false;
    this.suggestion = "old";
  }
}
class ValidationError extends StorageError {
  constructor(details = {}) {
    const merged = details;
    super();
    Object.assign(this, merged);
  }
}
const first = new ValidationError({ statusCode: 409, retriable: true, suggestion: "explicit" });
const second = new ValidationError();
console.log(first.statusCode, first.retriable, first.suggestion);
console.log(second.statusCode, second.retriable, second.suggestion);
