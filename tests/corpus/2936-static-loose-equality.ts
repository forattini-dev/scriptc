// Static Abstract Equality Comparison: primitive coercions, union-arm
// dispatch, evaluate-once ordering, and node:assert's legacy shallow pair.
import assert, { equal, notEqual } from "node:assert";

type Primitive = string | number | boolean | bigint | null | undefined;

function eq(a: Primitive, b: Primitive): boolean {
  return a == b;
}

function neq(a: Primitive, b: Primitive): boolean {
  return a != b;
}

console.log(eq("1", 1), eq("", 0), eq(" \t", 0), eq("0x10", 16), eq("no", 0));
console.log(eq(false, 0), eq(true, 1), eq(true, 2), eq(false, ""), eq(true, "1"));
console.log(eq(1n, 1), eq(1n, "01"), eq(1n, "1.0"), eq(0n, ""), eq(1n, true));
console.log(eq(9007199254740992n, 9007199254740992), eq(9007199254740993n, 9007199254740992));
console.log(eq(null, undefined), eq(null, 0), eq(undefined, false));
console.log(eq(0 / 0, 0 / 0), eq(0, -0), neq("2", 2), neq("2", 3));

type SymbolOrString = symbol | string;
function symbolEq(a: SymbolOrString, b: SymbolOrString): boolean {
  return a == b;
}
const shared = Symbol.for("shared");
console.log(symbolEq(shared, shared), symbolEq(Symbol("x"), Symbol("x")), symbolEq(shared, "shared"));

const sameArray = [1, 2];
function arrayEq(a: number[], b: number[]): boolean {
  return a == b;
}
console.log(arrayEq(sameArray, sameArray), arrayEq(sameArray, [1, 2]));

let order = "";
let leftCalls = 0;
let rightCalls = 0;
function left(): Primitive {
  order += "L";
  leftCalls++;
  return "1";
}
function right(): Primitive {
  order += "R";
  rightCalls++;
  return 1;
}
console.log(left() == right(), order, leftCalls, rightCalls);

assert.equal("1", 1);
assert.equal("", 0);
assert.equal(false, 0);
assert.equal(1n, "01");
assert.equal(0n, "");
assert.equal(null, undefined);
assert.equal(0 / 0, 0 / 0); // Node's legacy NaN exception.
assert.equal(0, -0);
assert.notEqual("2", 3);
equal(true, 1);
notEqual(2n, "3");

function unionAssert(a: Primitive, b: Primitive): void {
  assert.equal(a, b);
}
unionAssert(1n, "01");
unionAssert(false, "");

function messageOf(fn: () => void): string {
  try {
    fn();
    return "DID NOT THROW";
  } catch (error) {
    return error instanceof Error ? `${error.name}:${error.message}` : "not an Error";
  }
}

console.log(JSON.stringify(messageOf(() => assert.equal("1", 2))));
console.log(JSON.stringify(messageOf(() => assert.notEqual("1", 1))));
console.log(JSON.stringify(messageOf(() => assert.notEqual(0 / 0, 0 / 0))));
console.log(JSON.stringify(messageOf(() => assert.equal(1n, "2"))));
console.log(JSON.stringify(messageOf(() => assert.equal(null, 0))));
console.log(JSON.stringify(messageOf(() => assert.equal(Symbol("x"), Symbol("y")))));
console.log(JSON.stringify(messageOf(() => assert.equal(1, 2, "custom"))));
console.log(JSON.stringify(messageOf(() => assert.equal(1, 2, ""))));
console.log("done");
