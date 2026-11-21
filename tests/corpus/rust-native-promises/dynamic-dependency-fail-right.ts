import { value } from "./dynamic-dependency-failure.ts";
console.log("right should not run");
export function read(): string { return value(); }
