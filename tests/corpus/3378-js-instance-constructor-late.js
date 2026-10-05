// @no-engine
class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
  describe() { return this.constructor.name; }
}
const first = new StorageError("first");
const LaterError = class extends StorageError {};
const later = new LaterError("later");
console.log(first.name, first.describe());
console.log(later.name, later.describe());
