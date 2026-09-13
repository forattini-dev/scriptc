// @rust-only
/// <reference types="node" />
import { randomUUID } from "node:crypto";

function check(value: string): void {
  console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}
const first = crypto.randomUUID();
const second = globalThis.crypto.randomUUID();
check(first);
check(second);
check(randomUUID());
console.log(first !== second);
// Redcode's observability identifier pattern.
console.log(crypto.randomUUID().slice(0, 8).length);

function localCrypto(): void {
  const crypto = { randomUUID: (): string => "local crypto" };
  console.log(crypto.randomUUID());
}
function localGlobal(): void {
  const globalThis = { crypto: { randomUUID: (): string => "local global" } };
  console.log(globalThis.crypto.randomUUID());
}
localCrypto();
localGlobal();
