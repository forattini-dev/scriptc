// @rust-only
// @no-engine
// Native frontend entry: the legacy TS frontend refuses optional function values (SC1090).
import { defaults, optional } from "./main.ts";
const alias = defaults;
console.log("alias", alias(), alias(2));
const arrow = (a: number = 4, b?: number): number => {
  if (b === undefined) { return a; }
  return a + b;
};
console.log("arrow", arrow(), arrow(undefined, 0), arrow(2, 3));
const expression = function (value: number = 8): number { return value; };
console.log("expression", expression(), expression(0));
function apply(callback: (value?: number) => number): number {
  return callback() + callback(undefined) + callback(3);
}
console.log("contextual", apply((value = 7) => value * 2));
console.log("named-callback", apply(optional));
function required(callback: (value: number) => number): number { return callback(0); }
console.log("required-context", required((value = 8) => value));
