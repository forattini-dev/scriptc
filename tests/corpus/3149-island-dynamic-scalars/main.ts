// @dynamic
import { values, object, callback } from "dynbridge";

const number: unknown = values.number;
const text: unknown = values.text;
const bool: unknown = values.bool;
const absent: unknown = values.absent;
const nil: unknown = values.nil;
console.log(number === 5, text === "hi", bool === false, absent === undefined, nil === null);
console.log(typeof number, typeof text, typeof bool, typeof absent, typeof nil);
console.log(number ? "yes" : "no", bool ? "yes" : "no", absent ? "yes" : "no");

const negativeZero: unknown = values.negativeZero;
const nan: unknown = values.nan;
const infinity: unknown = values.infinity;
console.log(1 / (negativeZero as number), Number.isNaN(nan as number), infinity === Infinity);

const obj: unknown = object;
const fn: unknown = callback;
const objAgain: unknown = object;
const fnAgain: unknown = callback;
console.log(obj === objAgain, fn === fnAgain, typeof obj === "object", typeof fn === "function");
