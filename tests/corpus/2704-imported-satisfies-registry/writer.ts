import { limitInMib } from "./reader.ts";
import { RETENTION } from "./registry.ts";

export const LIMIT = RETENTION["events"].maxBytes;
const TARGET = RETENTION["events"].targetRatio;

export function report(): string {
  return `${LIMIT}:${TARGET}:${limitInMib()}`;
}
