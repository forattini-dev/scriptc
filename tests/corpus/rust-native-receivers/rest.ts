// @rust-only
// @no-engine
export {};
function total(this: { base: number }, start: number, ...values: number[]): number {
  return this.base + start + values[0] + values[1];
}
const receiver = { base: 10 };
console.log("call", total.call(receiver, 1, 2, 3));
const numbers: number[] = [1, 2, 3];
console.log("apply", (total as any).apply(receiver, numbers) as number);
const bound = total.bind(receiver, 1);
console.log("bind", bound(2, 3), bound.call({base: 100}, 4, 5));
function empty(this: any): boolean { return this === null; }
const erasedEmpty: any = empty;
console.log("empty", (erasedEmpty.apply(null) as boolean), (erasedEmpty.apply(null, undefined) as boolean), (erasedEmpty.apply(null, null) as boolean));
