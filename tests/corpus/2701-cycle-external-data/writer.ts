import { readLimitInKib } from "./reader.ts";
import { REGISTRY } from "./registry.ts";

export const LIMIT = REGISTRY["lane"].maxBytes;

export function report(): string {
  return `${LIMIT}:${readLimitInKib()}`;
}
