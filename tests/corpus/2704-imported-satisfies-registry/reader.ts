import { LIMIT } from "./writer.ts";

export function limitInMib(): number {
  return LIMIT / (1024 * 1024);
}
