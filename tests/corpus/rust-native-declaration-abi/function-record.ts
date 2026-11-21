import { apply, decorate, label, mutate, same } from "function-record";
console.log("apply", apply("hello"));
console.log("same", same());
console.log("direct", decorate("world"));
console.log("property", label());
console.log("mutate", mutate(), label());
