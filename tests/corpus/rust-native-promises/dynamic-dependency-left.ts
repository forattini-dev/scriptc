import { value } from "./dynamic-dependency-shared.ts";
console.log("left initialized");
export function read(): string { return value; }
