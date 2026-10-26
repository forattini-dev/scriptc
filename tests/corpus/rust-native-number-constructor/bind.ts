// @rust-only
// @no-engine
// @ts-nocheck
export {};
const words = (...args: any[]): string => String(args[0]) + ":" + String(args[1]) + ":" + String(args[2]) + ":" + String(args.length);
const prefix = words.bind(null, "first", 2);
console.log("rest", prefix("last"), prefix());
const twice = prefix.bind(null, "third");
console.log("twice", twice("extra"), twice !== prefix);
const text = String.bind(undefined, "chosen", "ignored");
console.log("string", text("extra"));
const number = Number.bind(undefined, "17", "ignored");
console.log("number", number("extra"));
const method = function(this: {value: string}, ...args: any[]): string { return this.value + String(args[0]); };
const fixed = method.bind({value: "a"}, "b");
console.log("receiver", fixed.call({value: "c"}, "d"));
