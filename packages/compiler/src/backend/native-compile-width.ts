import { availableParallelism } from "node:os";

export function nativeCompileWidth(maximum = availableParallelism()): number {
  const available = Math.max(1, Math.min(maximum, availableParallelism()));
  const configured = process.env["SCRIPTC_NATIVE_WORKERS"];
  if (configured === undefined || configured === "") return available;
  const width = Number(configured);
  if (!Number.isInteger(width) || width < 1) {
    throw new Error("SCRIPTC_NATIVE_WORKERS must be a positive integer");
  }
  return Math.min(available, width);
}
