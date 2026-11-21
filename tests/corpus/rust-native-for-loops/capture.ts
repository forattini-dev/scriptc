// @rust-only
// @no-engine
export {};

const callbacks: Array<() => number> = [];
for (let i = 0; i < 3; i++) {
  callbacks.push(() => i);
}
console.log("per iteration", callbacks.map((callback) => callback()).join(","));
