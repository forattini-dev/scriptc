// @rust-only
// @no-engine
export {};

const pattern: any = /hello/i;
const text: any = "hello";
console.log("regex instanceof", pattern instanceof RegExp, text instanceof RegExp);
