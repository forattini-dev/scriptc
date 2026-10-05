// @no-engine
class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
  describe() { return this.constructor.name + ": " + this.message; }
}
class NotFound extends StorageError {}
class NoSuchKey extends NotFound {}

for (const C of [StorageError, NotFound, NoSuchKey]) {
  const error = new C("missing");
  console.log(error.name, error.describe());
}
