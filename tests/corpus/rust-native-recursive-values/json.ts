type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue | undefined };
type JsonArray = JsonValue[] | readonly JsonValue[];
type JsonValue = JsonPrimitive | JsonObject | JsonArray;

function identity(value: JsonValue): JsonValue { return value; }
const array: JsonValue[] = ["hello", 42, true, null];
const object: JsonObject = { list: array, answer: 42 };
console.log(typeof identity("text"));
console.log(typeof identity(12));
console.log(typeof identity(false));
console.log(identity(null) === null);
const value: JsonValue = identity(object);
console.log(typeof value);
console.log(typeof object.answer);
console.log(array.length);
object.self = object;
console.log(object.self === object);
array.push(object);
console.log(array[4] === object);
