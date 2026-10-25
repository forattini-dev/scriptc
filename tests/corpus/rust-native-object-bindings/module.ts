// @rust-only
// @no-engine
export {};
const child = {value: 2};
const data = {child, count: 3, callback: (n: number): number => n * 2};
const {child: alias, callback: fn} = data;
let {count} = data;
function read(): void { console.log(alias === child, fn === data.callback, fn(count)); }
read();
alias.value = 8;
count = 5;
read();
console.log(child.value, data.count);
