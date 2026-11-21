const values: number[] = [1, 2, 3, 4];
const alias = values;
console.log(values.fill(9, -3, -1) === alias, values.join(","));
console.log(values.fill(5, 1).join(","));
console.log(values.fill(7, 3, 1).join(","));
const words: string[] = ["a", "b"];
console.log(words.fill("z").join("-"));
const effects: string[] = [];
const order: string[] = ["a", "b", "c"];
function value(): string { effects.push("value"); return "x"; }
function start(): number { effects.push("start"); order.push("d"); return 1; }
function end(): number { effects.push("end"); return 4; }
console.log("order", order.fill(value(), start(), end()).join(""), effects.join(","));
console.log("constructed", Array(3).fill("x").join("-"));
console.log(Array(0).fill("x").length);
function construct(value: any): string {
  const array = Array(value);
  return array.length + ":" + array.join("|");
}
console.log("dynamic", construct(3), construct("3"), construct(null), construct(false));
try { Array(-1); } catch (error) { console.log("negative", error instanceof RangeError); }
try { Array(1.5); } catch (error) { console.log("fraction", error instanceof RangeError); }
