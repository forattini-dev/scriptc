import { decode as read } from "recursive-contract";
import type { JsonValue } from "recursive-contract";

const decode = read;
const value: JsonValue = decode("number");
if (typeof value === "number") console.log(value + 1);
const object = decode("object", { strict: true });
console.log(typeof object);
const text = decode("text");
if (typeof text === "string") console.log(text);
