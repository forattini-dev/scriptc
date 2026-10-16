import { value, read } from "./cycle.ts";
export const initial = value === undefined && read() === undefined;
export function after(): number | undefined { return read(); }
