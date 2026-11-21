const colors: any = ['red', 'green', 'blue'];
let index: any = 5;

console.log(colors[index % colors.length]);

index = 5n;
const bigintKeys: any = { 1: 'bigint-key' };
// JavaScript ToPropertyKey accepts BigInt although TypeScript rejects it as an index type.
// @ts-ignore
console.log(bigintKeys[index % 2n]);
