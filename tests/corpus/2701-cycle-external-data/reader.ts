import { LIMIT } from "./writer.ts";

export function readLimitInKib(): number {
  return LIMIT / 1024;
}
