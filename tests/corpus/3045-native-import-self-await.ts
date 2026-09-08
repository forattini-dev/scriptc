// @no-engine
// @rust-only
// @exit: 13
console.log("before self import");
await import("./3045-native-import-self-await.ts");
console.log("unreachable");

export {};
