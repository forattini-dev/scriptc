// @no-engine
class StorageError extends Error {
  constructor(context) { super(context.message); this.code = context.code; }
}
class NotFound extends StorageError {}
class NoSuchKey extends StorageError {}
const ErrorMap = { NotFound, NoSuchKey };
console.log(Object.keys(ErrorMap).join(","));
console.log(ErrorMap.NotFound.name, ErrorMap.NoSuchKey.name);
console.log(ErrorMap.NotFound === NotFound, ErrorMap.NoSuchKey === NoSuchKey);
const error = new ErrorMap.NoSuchKey({ message: "missing key", code: "NoSuchKey" });
console.log(error.message, error.code, error instanceof NoSuchKey, error instanceof StorageError, error instanceof Error);
