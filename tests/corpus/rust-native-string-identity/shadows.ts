// @rust-only
// @no-engine
const custom = {
  text: "record",
  toString(): string { return this.text + " method"; },
  valueOf(): number { return 42; }
};
class Custom {
  text: string;
  constructor(value: string) { this.text = value; }
  toString(): string { return this.text + " method"; }
  valueOf(): string { return this.text + " value"; }
}
const instance = new Custom("class");
console.log("custom", custom.toString(), custom.valueOf(), instance.toString(), instance.valueOf());
function local(): string {
  const String = { toString(): string { return "local"; }, valueOf(): string { return "local value"; } };
  return String.toString() + "/" + String.valueOf();
}
console.log("shadow", local(), "primitive".toString(), "primitive".valueOf());
