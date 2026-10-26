export {};
type Callback = (value: number) => number;
const child = { value: 1 };
const callback: Callback = (value) => value + 4;
const source = {callback, child, label: "L"};
function select({callback: selected, ...rest}: typeof source): Callback {
  rest.child.value = 7;
  console.log("identity", selected === callback, rest.child === child);
  const alias = selected;
  return (value) => alias(value) + rest.child.value;
}
const selected = select(source);
console.log("closure", selected(2), child.value, source.label);
function fallback({callback: chosen = callback}: {callback?: Callback} = {}): number { return chosen(3); }
console.log("default-function", fallback(), fallback({callback}));
const object = { fn: function (this: any, n: number): number { console.log("this", this === undefined); return n; } };
function unbind({fn}: typeof object): number { return fn(5); }
console.log("receiver", unbind(object));
