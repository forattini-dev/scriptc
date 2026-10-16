import { value, update } from "./cycle.ts";
export function read(): number { return value; }
export function bump(): void { update(); }
