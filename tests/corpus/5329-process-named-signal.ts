// @ts-nocheck
/// <reference types="node" />
const signals = ["SIGINT", "SIGTERM"] as const;

for (const signal of signals) {
  const listener = () => console.log(`unexpected:${signal}`);
  process.once(signal, listener);
  process.off(signal, listener);
}

console.log("named signals removed");
