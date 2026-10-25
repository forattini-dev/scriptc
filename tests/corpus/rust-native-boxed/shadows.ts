// @rust-only
// @no-engine
export {};
class Number { value: number = 7; valueOf(): number { return this.value; } }
class String { valueOf(): string { return "custom"; } }
class Boolean { valueOf(): boolean { return false; } }
const n = new Number(); const s = new String(); const b = new Boolean();
console.log("shadowed", n.valueOf(), s.valueOf(), b.valueOf(), n instanceof Number, s instanceof String, b instanceof Boolean);
