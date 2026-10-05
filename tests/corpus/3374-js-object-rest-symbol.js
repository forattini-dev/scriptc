// @rust-only
// @no-engine
const key = Symbol("hidden");
class Copy {
  constructor(source) {
    Object.defineProperty(source, key, { value: "secret" });
    const { ...rest } = source;
    console.log(source[key], rest[key]);
    console.log(Object.keys(rest).join(","));
  }
}
new Copy({ visible: 1 });
