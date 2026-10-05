class Options { count = 0; }
class Copy {
  constructor(source) {
    Object.defineProperty(source, key, { value: "metadata" });
    Object.assign(target, source);
  }
}
const target = new Options();
const source = { count: 7 };
const key = Symbol("metadata");
try { new Copy(source); console.log("copied", target.count); }
catch (error) { console.log(error.code, target.count); }
