import { stackWithCauses } from "./causes.js";

class LinkedError extends Error {
  link(cause: Error): this {
    this.cause = cause;
    return this;
  }
}

const root = new LinkedError("root");
const middle = new LinkedError("middle").link(root);
const top = new LinkedError("top").link(middle);
console.log(stackWithCauses(top));
root.link(top);
console.log(stackWithCauses(top));

const a = [1, 2];
const b = [1, 2];
const arrays = new Set<number[]>([a]);
arrays.add(a);
console.log(arrays.size, arrays.has(a), arrays.has(b));
arrays.add(b);
console.log(arrays.size, arrays.delete(a), arrays.size, arrays.has(b));
for (const entry of arrays) {
  console.log(entry === b, entry.length);
}
