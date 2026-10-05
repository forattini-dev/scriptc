// @no-engine
class Base {
  constructor(context) { this.context = context; }
}
class Derived extends Base {
  constructor(details) {
    const { bucket, original, ...rest } = details;
    super({ bucket, statusCode: rest.statusCode ?? 404, ...rest });
    this.source = details;
    this.bucket = bucket;
    this.original = original;
  }
}
const shared = { id: 7 };
const details = { bucket: "demo", statusCode: 201, extra: "kept", original: "source", shared };
const value = new Derived(details);
console.log(value.bucket, value.original, value.context.statusCode, value.context.extra);
console.log(Object.keys(value.context).join(","));
value.context.extra = "changed";
console.log(details.extra, value.context.extra);
console.log(value.context.shared === value.source.shared);
