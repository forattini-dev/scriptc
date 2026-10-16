import { twice as localTwice } from "./common.ts";
console.log("right");
export function forward(value: number): number { return localTwice(value) + 1; }
