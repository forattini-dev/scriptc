type Base = { value: string };
type Wide = { value: string; values: string[]; callback: (x: string) => string; extra?: string };
function narrow(input: Wide): Base { return input; }
function copy(input: Base): Base { return { ...input }; }
const values = ["one"]; const callback = (x: string): string => x + "!";
const original: Wide = { value: "before", values, callback };
const view = narrow(original); const boxed: any = view; const raw: any = original;
console.log("case", boxed === raw, original === view, Object.keys(view).join("|"));
view.value = "after"; original.extra = "new";
console.log("case", original.value, Object.keys(view).join("|"));
const copied = copy(view); const result: any = copied;
console.log("case", result !== raw, result.values === values, result.callback === callback, Object.keys(copied).join("|"));
values.push("two"); console.log("case", original.values.join("|"), copied.value);

boxed.value = "through-any"; boxed.added = "dynamic";
console.log("case", original.value, Object.keys(copy(view)).join("|"));
function direct(input: Wide): Base { return {...input}; }
console.log("case", Object.keys(direct(original)).join("|"));

function read(input: {n:number}): number { return input.n; }
const width = { n: 1, extra: 2 }; console.log("case", read(width));

boxed.self = boxed;
const cyclic: any = copy(view);
console.log("case", cyclic.self === boxed, cyclic.self === cyclic);
