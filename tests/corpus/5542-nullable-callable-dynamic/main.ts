export {};
const original: any = function (value: number): number { return value + 2; };
original.marker = 'before';
const source: any = { method: original, nothing: null, absent: undefined };
const selected: ((value: number) => unknown) | null | undefined = source.method;
const nothing: ((value: number) => unknown) | null | undefined = source.nothing;
const absent: ((value: number) => unknown) | null | undefined = source.absent;
console.log('values', selected === original, selected?.(4), nothing?.(4), absent?.(4));
console.log('property', (selected as any).marker);
(selected as any).marker = 'after';
console.log('shared', original.marker);
const unbound: any = function (this: { base: number }, value: number): number { return this.base + value; };
const bound: any = unbound.bind({ base: 5 });
const boundSource: any = { method: bound };
const boundOne: ((value: number) => unknown) | undefined = boundSource.method;
const boundTwo: ((value: number) => unknown) | undefined = boundSource.method;
console.log('bound', boundOne === bound, boundOne === boundTwo, boundOne?.(2));
function consume(callback: ((value: number) => unknown) | undefined, raw: any): void {
  console.log('argument', callback === raw, callback?.(2));
}
consume(source.method, original);
consume(boundSource.method, bound);
