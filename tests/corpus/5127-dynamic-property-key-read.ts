function joinValues(values: any): string {
  let result = "";
  for (let index: any = 0; index < values.length; index++) {
    result += values[index];
  }
  return result;
}
console.log(joinValues(["a", "b", "c"]));
const record: any = { "0": "zero", "true": "boolean", "null": "null", "undefined": "undefined", "Symbol(key)": "string key" };
function readKey(key: any): any { return record[key]; }
console.log(readKey(-0) === "zero");
console.log(readKey(true) === "boolean");
console.log(readKey(null) === "null");
console.log(readKey(undefined) === "undefined");
console.log(readKey(Symbol("key")) === undefined);
function literalKey(): any { return "computed"; }
const computed: any = { [literalKey()]: "literal" };
console.log(computed.computed === "literal");
