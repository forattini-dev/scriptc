type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
function encode(value: JsonValue): string { return JSON.stringify(value); }
function write(value: JsonValue): string {
  const record = value as JsonObject;
  record.x = 9;
  return String(record.x);
}
const data = { x: 1 };
console.log(encode(data as unknown as JsonObject));
console.log(encode('hello'));
console.log(encode([1, 2]));
console.log('undefined:' + encode(undefined as unknown as JsonValue));
console.log(write(data as unknown as JsonObject));
console.log(data.x);
