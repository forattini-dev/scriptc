// Fixed-length tuple spreads flatten into ordinary static call ABIs. The
// tuple expression evaluates once, mixed/multiple spreads retain source
// order, and the same completion serves defaults, rest packs, overloads,
// methods, constructors, generics, and immutable callable aliases.

import { basename } from "node:path";

function describe(label: string, count: number, suffix = "!"): string {
  return `${label}:${count}${suffix}`;
}

const basic: readonly [string, number] = ["basic", 2];
console.log(describe(...basic));

let evaluations = 0;
function makePair(): [string, number] {
  evaluations = evaluations + 1;
  return ["once", 7];
}
console.log(describe(...makePair()), evaluations);

function mixed(a: string, b: number, c: boolean, d: string, e: number): string {
  return `${a}:${b}:${c}:${d}:${e}`;
}
const left: [string, number] = ["left", 1];
const right: [string, number] = ["right", 2];
console.log(mixed(...left, true, ...right));

const order: string[] = [];
function orderedPair(label: string, value: number): [string, number] {
  order.push(label);
  return [label, value];
}
function orderedMiddle(): boolean {
  order.push("middle");
  return true;
}
console.log(mixed(...orderedPair("first", 1), orderedMiddle(), ...orderedPair("last", 2)));
console.log(order.join(","));

function collect(head: string, ...values: number[]): string {
  return `${head}:${values.join(",")}`;
}
const rest: [number, number, number] = [3, 4, 5];
console.log(collect("rest", ...rest));

function pick(kind: "s", value: string): string;
function pick(kind: "n", value: number): number;
function pick(kind: "s" | "n", value: string | number): string | number {
  if (typeof value === "string") return value.toUpperCase();
  return value + 1;
}
const choose = pick;
const stringArgs: ["s", string] = ["s", "alias"];
const numberArgs: ["n", number] = ["n", 40];
console.log(choose(...stringArgs), choose(...numberArgs));

function genericPair<T, U>(a: T, b: U): string {
  return `${a}:${b}`;
}
const genericArgs: [string, number] = ["generic", 9];
console.log(genericPair(...genericArgs));

const pathArgs: [string, string] = ["/tmp/static-spread.ts", ".ts"];
const base = basename;
console.log(base(...pathArgs));
const pathOnly: [string] = ["/tmp/default-suffix.ts"];
console.log(base(...pathOnly));

class Box {
  value: string;
  constructor(prefix: string, value: number) {
    this.value = `${prefix}:${value}`;
  }
  add(prefix: string, value: number): string {
    return `${this.value}:${prefix}:${value}`;
  }
}
const ctorArgs: [string, number] = ["box", 10];
const methodArgs: [string, number] = ["method", 11];
const box = new Box(...ctorArgs);
console.log(box.add(...methodArgs));
