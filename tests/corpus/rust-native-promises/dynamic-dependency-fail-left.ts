import { value } from "./dynamic-dependency-failure.ts";
console.log("left should not run");
export function read(): string { return value(); }
