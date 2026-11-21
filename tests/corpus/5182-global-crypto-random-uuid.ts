/// <reference lib="dom" />

console.log(crypto.randomUUID().length === 36);
console.log(globalThis.crypto.randomUUID().length === 36);

function localCrypto(): string {
  const crypto = { randomUUID: (): string => "local" };
  return crypto.randomUUID();
}

console.log(localCrypto());
