class Holder {
  values = new WeakMap<object, number>();
}
function first<T>(...values: T[]): T { return values[0]; }
const key = {};
const holder = new Holder();
holder.values.set(key, 7);
const selected = first(holder);
console.log(selected === holder, selected.values.get(key));
