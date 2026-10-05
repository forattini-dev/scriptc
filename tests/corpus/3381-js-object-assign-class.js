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
  constructor() {
    super();
    const merged = { statusCode: 422, retriable: true, suggestion: "new" };
    const result = Object.assign(this, merged);
    console.log(result === this, this.statusCode, this.retriable, this.suggestion);
  }
}
const value = new ValidationError();
console.log(value.statusCode, value.retriable, value.suggestion, value instanceof StorageError);
