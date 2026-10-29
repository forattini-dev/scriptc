const offset = 3;
const add = function internal(value: number): number { return value + offset; };
const alias = add;
const other = function same(same: number): number { return same * 2; };
function create(amount: number): (value: number) => number {
  return function inner(value: number): number { return amount + value; };
}
const one = create(10);
const two = create(20);
console.log("calls", add(4), alias(5), other(6), one(1), two(1));
console.log("identity", add === alias, one === two);
