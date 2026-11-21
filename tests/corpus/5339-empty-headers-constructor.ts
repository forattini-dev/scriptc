// @rust-only
// @no-engine
/// <reference lib="dom" />
export {};

const headers = new Headers();
console.log(headers.has("x-native"));
headers.append("x-native", "first");
headers.append("x-native", "second");
console.log(headers.get("x-native"), headers.has("x-native"));
