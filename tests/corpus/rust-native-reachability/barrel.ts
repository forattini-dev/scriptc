export { twice } from "./dependency.ts";
console.log("barrel initialization");
export function unusedBarrel(value: unknown): unknown { return value; }
