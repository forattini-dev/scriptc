import { value } from "./dynamic-dependency-shared.ts";
console.log("right initialized");
export function read(): string { return value; }
