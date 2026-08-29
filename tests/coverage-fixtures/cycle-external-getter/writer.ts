import { readLimit } from "./reader.ts";
import { REGISTRY } from "./registry.ts";

export const LIMIT = REGISTRY.lane.maxBytes;

export function report(): number {
  return readLimit();
}
