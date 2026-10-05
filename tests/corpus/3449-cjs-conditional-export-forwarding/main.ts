import { default as first } from "./choice.cjs";
import again from "./bridge.ts";
console.log(first(7), again(7), first === again);
