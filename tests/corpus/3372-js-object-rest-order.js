// @no-engine
class StorageError extends Error {
  constructor(message, context) { super(message); this.context = context; }
}
class LastSpread extends StorageError {
  constructor(details) {
    const { bucket, key, original, ...rest } = details;
    super(`No such key: ${key} [bucket:${bucket}]`, {
      bucket, key, original, statusCode: rest.statusCode ?? 404,
      retriable: rest.retriable ?? false, ...rest,
    });
  }
}
class FirstSpread extends StorageError {
  constructor(details) {
    const { plugin, ...rest } = details;
    super(`Plugin: ${plugin}`, { ...rest, plugin, statusCode: rest.statusCode ?? 500 });
  }
}
for (const statusCode of [409, undefined, null]) {
  const last = new LastSpread({ bucket: "b", key: "k", statusCode, note: "kept" });
  const first = new FirstSpread({ plugin: "p", statusCode, note: "kept" });
  console.log(last.message, last.context.statusCode, last.context.retriable, last.context.note);
  console.log(first.message, first.context.statusCode, first.context.note);
}
class Copy {
  constructor(details) {
    this.source = details;
    const { bucket: renamed, missing = this.add(), ...rest } = details;
    this.renamed = renamed;
    this.missing = missing;
    this.rest = rest;
  }
  add() { this.source.added = "during-default"; return "default"; }
}
const copy = new Copy({ bucket: "b", renamed: "keep", "10": "ten", "2": "two", tail: "last", nested: { value: 1 }, absent: undefined });
console.log(Object.keys(copy.rest).join(","));
console.log(copy.renamed, copy.rest.renamed, copy.missing, copy.rest.added);
console.log(Object.hasOwn(copy.rest, "absent"), Object.hasOwn(copy.rest, "bucket"), Object.hasOwn(copy.rest, "missing"));
copy.source.tail = "changed";
copy.rest.nested.value = 2;
console.log(copy.source.tail, copy.rest.tail, copy.source.nested.value, copy.rest.nested === copy.source.nested);
