import { failure } from "./state.ts";
const shared = Promise.resolve(7);
const sharedVoid = Promise.resolve();

export function cachedDone(): Promise<void> { return sharedVoid; }
export function cached(): Promise<number> { return shared; }
export async function add(value: number): Promise<number> {
  console.log("start", value);
  await Promise.resolve();
  console.log("settle", value);
  return value + 1;
}
export { add as aliasAdd };
export async function done(): Promise<void> {
  await Promise.resolve();
  console.log("done");
}
export async function fail(): Promise<number> {
  await Promise.resolve();
  throw failure;
}
export async function text(): Promise<string> { return "native"; }
export async function flag(): Promise<boolean> { return true; }
